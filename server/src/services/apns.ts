// APNs sender (token-based / .p8 auth, HTTP/2). Bun's fetch can't speak APNs's
// HTTP/2-only protocol, so we use node:http2 directly. The provider JWT (ES256,
// signed with the .p8 EC key) is cached and reused for up to ~50 min.

import { connect } from "node:http2";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SECRETS_DIR = join(import.meta.dir, "../../.secrets");
const TOPIC = process.env.APNS_TOPIC || "eu.chezmaurice.maurice";
// Carnet is a second app: its tokens belong to its own bundle id, and APNs
// answers DeviceTokenNotForTopic when the topic is wrong.
const CARNET_TOPIC = process.env.APNS_CARNET_TOPIC || "eu.chezmaurice.carnet.app";

// Both apps are on the company's developer team, and an APNs key signs for a
// whole team: one provider (team, key id, key file) serves both. The key id has
// no default — it names the key made on that team, with APNS_KEY_ID.
interface Provider { teamId: string; keyId: string; keyPath?: string }
const PROVIDER: Provider = {
  teamId: process.env.APNS_TEAM_ID || "F5B4ZC8LEU",
  keyId: process.env.APNS_KEY_ID || "",
  keyPath: process.env.APNS_KEY_PATH,
};

function isCarnet(platform: string | null | undefined): boolean {
  return (platform ?? "").startsWith("carnet");
}

/** The platforms whose tokens are APNs tokens. A row with no platform predates
 *  the column and came from the Maurice app. Anything else (an Android client's
 *  token, say) is not Apple's to deliver: sent there it comes back
 *  BadDeviceToken and would be pruned as dead. */
const APPLE_PLATFORMS = new Set(["ios", "macos", "carnet-ios"]);
export function isApplePlatform(platform: string | null | undefined): boolean {
  return !platform || APPLE_PLATFORMS.has(platform);
}

/** The APNs topic for a device token, from the platform the client registered
 *  it with (`carnet-ios` → Carnet's bundle id; anything else → the Maurice app). */
export function apnsTopicFor(platform: string | null | undefined): string {
  return isCarnet(platform) ? CARNET_TOPIC : TOPIC;
}
// A device token belongs to one APNs environment — sandbox for a build run from
// Xcode, production for a TestFlight or App Store build — and the token does not
// say which. Both kinds register with the same server, so a token the first
// environment refuses as BadDeviceToken is tried on the other, and the one that
// took it is remembered. APNS_PRODUCTION=1 only picks which is tried first.
const SANDBOX = "https://api.sandbox.push.apple.com";
const PRODUCTION = "https://api.push.apple.com";
const HOSTS = process.env.APNS_PRODUCTION === "1" ? [PRODUCTION, SANDBOX] : [SANDBOX, PRODUCTION];
const hostOf = new Map<string, string>();

/** Try a token's known environment, else each in turn; BadDeviceToken from all
 *  of them means the token is dead, anything else is the answer. */
export async function sendToEitherHost(
  deviceToken: string,
  post: (host: string) => Promise<ApnsResult>,
  hosts: string[] = HOSTS,
  known: Map<string, string> = hostOf,
): Promise<ApnsResult> {
  const first = known.get(deviceToken);
  const order = first ? [first, ...hosts.filter((h) => h !== first)] : hosts;
  let last: ApnsResult = { ok: false, status: 0, reason: "NoHost" };
  for (const host of order) {
    last = await post(host);
    if (last.ok) known.set(deviceToken, host);
    if (last.reason !== "BadDeviceToken") return last;
  }
  known.delete(deviceToken);
  return last;
}

/** The provider's key: the file it names, else `AuthKey_<key id>.p8` in the
 *  secrets directory. */
function loadKeyPem(p: Provider): string | null {
  try {
    const path = p.keyPath || (p.keyId ? join(SECRETS_DIR, `AuthKey_${p.keyId}.p8`) : "");
    return path ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

export function apnsConfigured(): boolean {
  return loadKeyPem(PROVIDER) !== null;
}

// ── Provider JWT (ES256) ────────────────────────────────────────

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlStr(s: string): string {
  return b64url(new TextEncoder().encode(s));
}
function pemToDer(pem: string): Uint8Array {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(Buffer.from(body, "base64"));
}

const cached = new Map<Provider, { jwt: string; at: number }>();
const signingKeys = new Map<Provider, CryptoKey>();

async function providerToken(p: Provider): Promise<string | null> {
  const now = Math.floor(Date.now() / 1000);
  const hit = cached.get(p);
  if (hit && now - hit.at < 3000) return hit.jwt; // APNs allows reuse < 60 min
  const pem = loadKeyPem(p);
  if (!pem) return null;
  let signingKey = signingKeys.get(p);
  if (!signingKey) {
    signingKey = await crypto.subtle.importKey(
      "pkcs8", pemToDer(pem) as any, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
    );
    signingKeys.set(p, signingKey);
  }
  const input = `${b64urlStr(JSON.stringify({ alg: "ES256", kid: p.keyId }))}.${b64urlStr(JSON.stringify({ iss: p.teamId, iat: now }))}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signingKey, new TextEncoder().encode(input));
  const jwt = `${input}.${b64url(new Uint8Array(sig))}`;
  cached.set(p, { jwt, at: now });
  return jwt;
}

// ── Send ────────────────────────────────────────────────────────

export interface ApnsResult {
  ok: boolean;
  status: number;
  reason?: string;
}

/** A push's content, and the same sealed for the device when it gave keys. */
export interface ApplePush {
  title: string;
  body: string;
  conversationId?: string;
  /** An entry Carnet opens on the tap, `<collection>/<locale>/<slug>`. */
  entry?: string;
  householdTag?: string;
  platform?: string;
  /** The fields above, encrypted to the device's keys (RFC 8291, base64url):
   *  then none of them is sent in clear, and the app's notification service
   *  extension opens them. */
  sealed?: string;
}

/** The app a token belongs to, as the push relay names it. */
export function appFor(platform: string | null | undefined): "maurice" | "carnet" {
  return isCarnet(platform) ? "carnet" : "maurice";
}

/**
 * The JSON Apple carries. A sealed push says only "New message" (`loc-key`,
 * translated by the app's own strings) and wakes the app's notification
 * service extension (`mutable-content`), which decrypts `sealed` and shows the
 * real title and text; if it cannot, the generic line is what shows. Without
 * a seal the content goes in clear: an app too old to have sent keys. The push
 * relay builds the sealed shape itself (chezmaurice-tower, push-relay.ts).
 */
export function applePayload(p: ApplePush): Record<string, unknown> {
  if (p.sealed) {
    return { aps: { alert: { "loc-key": "New message" }, sound: "default", "mutable-content": 1 }, sealed: p.sealed };
  }
  return {
    aps: { alert: { title: p.title, body: p.body }, sound: "default" },
    ...(p.conversationId ? { conversationId: p.conversationId } : {}),
    ...(p.entry ? { entry: p.entry } : {}),
    ...(p.householdTag ? { householdTag: p.householdTag } : {}),
  };
}

// ── The push relay ──────────────────────────────────────────────

/**
 * A household without the APNs key — one run at home by anyone but the
 * operator — reaches Apple devices through Chez Maurice's push relay, which
 * holds it (chezmaurice-tower, push-relay.ts). The relay is given the token,
 * the app and the sealed content, never anything in clear: a push for a device
 * that gave no keys goes as the bare "New message". MAURICE_PUSH_RELAY_URL=off
 * keeps a household from using it; it then sends no Apple push at all.
 */
export function pushRelayURL(): string | null {
  const v = (process.env.MAURICE_PUSH_RELAY_URL ?? "https://push.chezmaurice.eu").trim().replace(/\/+$/, "");
  return v && v !== "off" ? v : null;
}

export async function sendViaRelay(
  relay: string,
  deviceToken: string,
  p: ApplePush,
  fetcher: typeof fetch = fetch,
): Promise<ApnsResult> {
  try {
    const res = await fetcher(`${relay}/v1/apns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: deviceToken, app: appFor(p.platform), ...(p.sealed ? { sealed: p.sealed } : {}) }),
      signal: AbortSignal.timeout(10_000),
    });
    const got = (await res.json().catch(() => ({}))) as Partial<ApnsResult>;
    // Apple's answer passed through, so a dead token is pruned as on a direct send.
    return { ok: res.ok && got.ok !== false, status: got.status ?? res.status, reason: got.reason };
  } catch (e) {
    return { ok: false, status: 0, reason: `relay: ${e instanceof Error ? e.message : e}` };
  }
}

/** Send one alert push to a device token: directly when this household holds
 *  the APNs key, else through the push relay. Returns Apple's status + reason
 *  (e.g. "BadDeviceToken", "Unregistered") so the caller can prune dead tokens. */
export async function sendApns(deviceToken: string, payload: ApplePush): Promise<ApnsResult> {
  const jwt = await providerToken(PROVIDER);
  if (!jwt) {
    const relay = pushRelayURL();
    return relay ? sendViaRelay(relay, deviceToken, payload) : { ok: false, status: 0, reason: "NoProviderKey" };
  }

  const body = JSON.stringify(applePayload(payload));

  return sendToEitherHost(deviceToken, (host) => new Promise<ApnsResult>((resolve) => {
    let settled = false;
    const done = (r: ApnsResult) => { if (!settled) { settled = true; resolve(r); } };
    const client = connect(host);
    client.on("error", (e: any) => { done({ ok: false, status: 0, reason: String(e?.message || e) }); try { client.close(); } catch {} });
    const req = client.request({
      ":method": "POST",
      ":path": `/3/device/${deviceToken}`,
      authorization: `bearer ${jwt}`,
      "apns-topic": apnsTopicFor(payload.platform),
      "apns-push-type": "alert",
      "apns-priority": "10",
    });
    let status = 0;
    let data = "";
    req.on("response", (h) => { status = Number(h[":status"]); });
    req.on("data", (c) => { data += c; });
    req.on("end", () => {
      let reason: string | undefined;
      try { reason = data ? JSON.parse(data).reason : undefined; } catch {}
      try { client.close(); } catch {}
      done({ ok: status === 200, status, reason });
    });
    req.on("error", (e: any) => done({ ok: false, status: 0, reason: String(e?.message || e) }));
    req.end(body);
  }));
}
