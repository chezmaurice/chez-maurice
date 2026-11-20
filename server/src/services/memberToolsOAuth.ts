import { createHash, randomBytes } from "node:crypto";

// Signing in to a member's own MCP server (20 November 2026): the protocol,
// and nothing else — no database, no member. services/memberTools.ts holds
// the rows and decides who may; this file knows how an MCP server says where
// to sign in and how a token is obtained and renewed.
//
// It follows the MCP authorization spec: the server answers 401 and names
// its protected-resource metadata (RFC 9728), which names an authorization
// server; that one publishes its endpoints (RFC 8414, or OpenID discovery);
// Maurice registers itself there as a public client (RFC 7591), sends the
// member to sign in with PKCE (S256) and the resource it wants the token for
// (RFC 8707), and exchanges the code that comes back. Older servers publish
// no metadata: their own origin is then the authorization server, at
// /authorize, /token and /register.
//
// Every request goes through the fetch it is given — the SSRF guard, for a
// member's server — and what comes back is read with a bound.

/** `redirects`: how many may be followed. None for anything that carries a secret. */
export type OAuthFetch = (url: string, init: RequestInit, redirects: number) => Promise<Response>;

export interface OAuthPlan {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  /** The scopes to ask for, when the server names any. */
  scope: string | null;
  /** What the token is for: the MCP server's address. */
  resource: string;
}

export interface OAuthClient {
  clientId: string;
  clientSecret: string | null;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch milliseconds, or null when the server gave no lifetime. */
  expiresAt: number | null;
}

export class OAuthError extends Error {}

const META_TIMEOUT_MS = 10_000;
const MAX_META_BYTES = 200_000;

async function boundedText(resp: Response): Promise<string> {
  const reader = resp.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        bytes += value.byteLength;
        if (bytes > MAX_META_BYTES) throw new OAuthError("the server's answer is too large");
        text += decoder.decode(value, { stream: true });
      }
      if (done) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return text;
}

async function getJson(f: OAuthFetch, url: string): Promise<any | null> {
  try {
    const resp = await f(url, { method: "GET", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(META_TIMEOUT_MS) }, 3);
    if (!resp.ok) {
      resp.body?.cancel().catch(() => {});
      return null;
    }
    const v = JSON.parse(await boundedText(resp));
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

function httpsUrl(v: unknown, allowHttp: boolean): string | null {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || (allowHttp && u.protocol === "http:") ? u.toString() : null;
  } catch {
    return null;
  }
}

/** `Bearer resource_metadata="…", scope="…"` → its parameters. */
export function parseChallenge(header: string | null): { resourceMetadata: string | null; scope: string | null } {
  const param = (name: string) => header?.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i"))?.[1] ?? null;
  return { resourceMetadata: param("resource_metadata"), scope: param("scope") };
}

/**
 * Where to sign in for this MCP server. `challenge` is the WWW-Authenticate
 * header of its 401. `allowHttp` is for a server on the household's own
 * network, which an admin may add: everyone else gets https endpoints only.
 */
export async function discoverOAuth(serverUrl: string, f: OAuthFetch, challenge: string | null, allowHttp = false): Promise<OAuthPlan> {
  const server = new URL(serverUrl);
  server.hash = "";
  const path = server.pathname.replace(/\/+$/, "");
  const asked = parseChallenge(challenge);

  // 1. The protected resource says which authorization server it trusts.
  const resourceCandidates = [
    httpsUrl(asked.resourceMetadata, allowHttp),
    path ? `${server.origin}/.well-known/oauth-protected-resource${path}` : null,
    `${server.origin}/.well-known/oauth-protected-resource`,
  ].filter((u): u is string => !!u);
  let issuer: string | null = null;
  let scopes: string | null = asked.scope;
  for (const url of [...new Set(resourceCandidates)]) {
    const meta = await getJson(f, url);
    const first = Array.isArray(meta?.authorization_servers) ? httpsUrl(meta.authorization_servers[0], allowHttp) : null;
    if (!first) continue;
    issuer = first;
    if (!scopes && Array.isArray(meta.scopes_supported) && meta.scopes_supported.length) scopes = meta.scopes_supported.filter((s: unknown) => typeof s === "string").join(" ");
    break;
  }

  // 2. The authorization server says where its endpoints are.
  const legacy = !issuer;
  const as = new URL(issuer ?? server.origin);
  const asPath = as.pathname.replace(/\/+$/, "");
  const metaCandidates = asPath
    ? [`${as.origin}/.well-known/oauth-authorization-server${asPath}`, `${as.origin}/.well-known/openid-configuration${asPath}`, `${as.origin}${asPath}/.well-known/openid-configuration`]
    : [`${as.origin}/.well-known/oauth-authorization-server`, `${as.origin}/.well-known/openid-configuration`];
  let meta: any = null;
  for (const url of metaCandidates) {
    meta = await getJson(f, url);
    if (meta?.authorization_endpoint && meta?.token_endpoint) break;
    meta = null;
  }
  if (!meta) {
    // No metadata anywhere. The first MCP spec gave such servers default
    // paths on their own origin; an authorization server named by the
    // resource but silent about itself is a dead end.
    if (!legacy) throw new OAuthError("the service's sign-in server does not say how to sign in");
    meta = { authorization_endpoint: `${server.origin}/authorize`, token_endpoint: `${server.origin}/token`, registration_endpoint: `${server.origin}/register` };
  }
  const methods = meta.code_challenge_methods_supported;
  if (Array.isArray(methods) && !methods.includes("S256")) throw new OAuthError("the service's sign-in does not support the protection Maurice requires (PKCE S256)");
  const authorizationEndpoint = httpsUrl(meta.authorization_endpoint, allowHttp);
  const tokenEndpoint = httpsUrl(meta.token_endpoint, allowHttp);
  if (!authorizationEndpoint || !tokenEndpoint) throw new OAuthError("the service's sign-in addresses are not valid");
  return {
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint: httpsUrl(meta.registration_endpoint, allowHttp),
    scope: scopes,
    resource: server.toString(),
  };
}

async function postForJson(f: OAuthFetch, url: string, body: string, contentType: string, what: string): Promise<any> {
  let resp: Response;
  try {
    resp = await f(url, { method: "POST", headers: { "Content-Type": contentType, Accept: "application/json" }, body, signal: AbortSignal.timeout(META_TIMEOUT_MS) }, 0);
  } catch (err: any) {
    throw new OAuthError(`${what}: ${err?.name === "TimeoutError" ? "no answer in time" : String(err?.message ?? "unreachable").slice(0, 200)}`);
  }
  const text = await boundedText(resp).catch(() => "");
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch { /* not JSON: said below */ }
  if (!resp.ok || !json || typeof json !== "object") {
    const said = json?.error_description || json?.error || `it answered ${resp.status}`;
    throw new OAuthError(`${what}: ${String(said).slice(0, 200)}`);
  }
  return json;
}

/** Register Maurice with the authorization server, as a public client. */
export async function registerClient(plan: OAuthPlan, redirectUri: string, f: OAuthFetch): Promise<OAuthClient> {
  if (!plan.registrationEndpoint) throw new OAuthError("this service only lets applications it already knows sign in, and Maurice is not one of them");
  const json = await postForJson(f, plan.registrationEndpoint, JSON.stringify({
    client_name: "Maurice",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    ...(plan.scope ? { scope: plan.scope } : {}),
  }), "application/json", "the service refused to register Maurice");
  if (typeof json.client_id !== "string" || !json.client_id) throw new OAuthError("the service registered Maurice without giving it an identifier");
  return { clientId: json.client_id, clientSecret: typeof json.client_secret === "string" && json.client_secret ? json.client_secret : null };
}

/** A fresh PKCE pair and state for one sign-in. */
export function newSignIn(): { state: string; verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { state: randomBytes(32).toString("base64url"), verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** The address the member's browser is sent to. */
export function authorizeUrl(plan: OAuthPlan, client: OAuthClient, redirectUri: string, state: string, challenge: string): string {
  const u = new URL(plan.authorizationEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", client.clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("resource", plan.resource);
  if (plan.scope) u.searchParams.set("scope", plan.scope);
  return u.toString();
}

function tokenSet(json: any, previousRefresh: string | null): TokenSet {
  if (typeof json.access_token !== "string" || !json.access_token) throw new OAuthError("the service answered without a token");
  if (json.token_type && String(json.token_type).toLowerCase() !== "bearer") throw new OAuthError(`the service gave a kind of token Maurice cannot use (${String(json.token_type).slice(0, 40)})`);
  const lifetime = Number(json.expires_in);
  return {
    accessToken: json.access_token,
    // A server that does not rotate keeps the one it gave before.
    refreshToken: typeof json.refresh_token === "string" && json.refresh_token ? json.refresh_token : previousRefresh,
    expiresAt: Number.isFinite(lifetime) && lifetime > 0 ? Date.now() + lifetime * 1000 : null,
  };
}

function form(fields: Record<string, string | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) if (v) p.set(k, v);
  return p.toString();
}

/** The code the sign-in came back with, for a token. */
export async function exchangeCode(
  o: { tokenEndpoint: string; resource: string; client: OAuthClient; redirectUri: string; code: string; verifier: string },
  f: OAuthFetch,
): Promise<TokenSet> {
  const json = await postForJson(f, o.tokenEndpoint, form({
    grant_type: "authorization_code", code: o.code, redirect_uri: o.redirectUri, client_id: o.client.clientId,
    client_secret: o.client.clientSecret, code_verifier: o.verifier, resource: o.resource,
  }), "application/x-www-form-urlencoded", "the service did not give a token");
  return tokenSet(json, null);
}

/** A new access token from the refresh token. */
export async function refreshTokens(
  o: { tokenEndpoint: string; resource: string; client: OAuthClient; refreshToken: string },
  f: OAuthFetch,
): Promise<TokenSet> {
  const json = await postForJson(f, o.tokenEndpoint, form({
    grant_type: "refresh_token", refresh_token: o.refreshToken, client_id: o.client.clientId,
    client_secret: o.client.clientSecret, resource: o.resource,
  }), "application/x-www-form-urlencoded", "the service did not renew the sign-in");
  return tokenSet(json, o.refreshToken);
}
