// A member's own MCP servers (20 November 2026, services/memberTools.ts).
// What is held down here: a server is asked for its tools before it is kept,
// and one that does not answer or refuses the token is not; the token is
// sealed and never comes back out; the tools are named `x_<server>__<tool>`,
// bounded, and routed to the member's server with the server's own names; a
// member reaches only their own servers; a guest has none; an address that
// is not public https is refused, and a redirect is not followed; a server
// switched off or removed can no longer be called, even from a stale roster;
// the picker lists them; the member's erasure takes them.

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

process.env.MAURICE_MEMBER_TOOLS_PRIVATE = "1";

const db = (await import("../src/db")).default;
const svc = await import("../src/services/memberTools");
const routes = (await import("../src/routes/toolServers")).default;
const families = await import("../src/services/toolFamilies");
const { createSession } = await import("../src/services/auth");

// An admin (who may reach the fake server on loopback), a standard member, a guest.
const ADA = "mt-ada";
const BEN = "mt-ben";
const GUS = "mt-gus";
const auth: Record<string, string> = {};

// ── a fake MCP server ────────────────────────────────────────────────────

interface Call { method: string; auth: string | null; key: string | null; params: any }
let calls: Call[] = [];
let token = "s3cret";
let tools: any[] = [];
let sse = false;
let redirect = false;
let fake: ReturnType<typeof Bun.serve>;
let url = "";

const rpc = (id: number, result: unknown) => ({ jsonrpc: "2.0", id, result });

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  for (const [id, role] of [[ADA, "admin"], [BEN, "standard"], [GUS, "guest"]] as const) {
    db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, ?)`, [id, id, id, role]);
    auth[id] = `Bearer ${createSession(id).token}`;
  }
  fake = Bun.serve({
    port: 0,
    async fetch(req) {
      if (redirect) return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:1/elsewhere" } });
      if (req.method !== "POST" || new URL(req.url).pathname !== "/mcp") return new Response("not found", { status: 404 });
      const body = (await req.json()) as any;
      calls.push({ method: body.method, auth: req.headers.get("authorization"), key: req.headers.get("x-api-key"), params: body.params });
      const given = req.headers.get("authorization") ?? (req.headers.get("x-api-key") ? `Bearer ${req.headers.get("x-api-key")}` : null);
      if (token && given !== `Bearer ${token}`) return new Response("bad token", { status: 401 });
      if (body.id === undefined) return new Response(null, { status: 202 });
      let result: unknown;
      if (body.method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fake" } };
      else if (body.method === "tools/list") result = { tools };
      else if (body.method === "tools/call") result = { content: [{ type: "text", text: `called ${body.params.name} with ${JSON.stringify(body.params.arguments)}` }] };
      else return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "no such method" } });
      if (sse) {
        // A notification first, then the answer — and the stream left open.
        const stream = new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\n`));
            c.enqueue(new TextEncoder().encode(`event: message\ndata: ${JSON.stringify(rpc(body.id, result))}\n\n`));
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream", "mcp-session-id": "s1" } });
      }
      return Response.json(rpc(body.id, result), { headers: { "mcp-session-id": "s1" } });
    },
  });
  url = `http://127.0.0.1:${fake.port}/mcp`;
});

afterAll(() => {
  fake.stop(true);
  // The suites share one database: other suites count the household's names.
  db.run(`DELETE FROM users WHERE id IN (?, ?, ?)`, [ADA, BEN, GUS]);
});

beforeEach(() => {
  db.run(`DELETE FROM member_tool_servers`);
  svc.resetToolSessions();
  calls = [];
  token = "s3cret";
  sse = false;
  redirect = false;
  tools = [
    { name: "search", description: "Search  the\n workspace.", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } },
    { name: "create page", description: "Create a page." },
  ];
});

function call(who: string, path: string, init: RequestInit = {}) {
  return routes.request(path, { ...init, headers: { Authorization: auth[who]!, "Content-Type": "application/json", ...(init.headers ?? {}) } });
}
const add = (who: string, body: unknown) => call(who, "/", { method: "POST", body: JSON.stringify(body) });

// ── adding ───────────────────────────────────────────────────────────────

test("a server is asked for its tools before it is kept; the token is sealed and never returned", async () => {
  const res = await add(ADA, { name: "Notion (work)", url, token: "s3cret" });
  expect(res.status).toBe(201);
  const row = (await res.json()) as any;
  expect(row).toMatchObject({ name: "Notion (work)", prefix: "x_notion-work", has_token: true, enabled: true, state: "ok", dropped: 0 });
  expect(row.tools).toEqual([{ name: "create page", description: "Create a page." }, { name: "search", description: "Search the workspace." }]);
  expect(JSON.stringify(row)).not.toContain("s3cret");
  expect(calls.map((c) => c.method)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
  expect(calls[0]!.auth).toBe("Bearer s3cret");
  const stored = db.query(`SELECT secret FROM member_tool_servers`).get() as { secret: string };
  expect(stored.secret.startsWith("v1:")).toBe(true);
  expect(stored.secret).not.toContain("s3cret");
  const listed = (await (await call(ADA, "/")).json()) as any;
  expect(listed.allowed).toBe(true);
  expect(listed.servers).toHaveLength(1);
  expect(JSON.stringify(listed)).not.toContain("s3cret");
});

test("a refused token, or a server that is not there, keeps nothing and says why", async () => {
  const refused = await add(ADA, { name: "Notion", url, token: "wrong" });
  expect(refused.status).toBe(422);
  expect(((await refused.json()) as any).error).toContain("refused the token");
  const gone = await add(ADA, { name: "Nowhere", url: "http://127.0.0.1:1/mcp" });
  expect(gone.status).toBe(422);
  expect(db.query(`SELECT COUNT(*) AS n FROM member_tool_servers`).get()).toEqual({ n: 0 });
});

test("a token may go in a header of its own; some headers may not carry one", async () => {
  const res = await add(ADA, { name: "Keyed", url, token: "s3cret", auth_header: "X-Api-Key" });
  expect(res.status).toBe(201);
  expect(calls[0]).toMatchObject({ auth: null, key: "s3cret" });
  expect((await add(ADA, { name: "Bad", url: url + "?2", token: "t", auth_header: "Host" })).status).toBe(400);
});

test("an event stream is read up to the answer, even when the server leaves it open", async () => {
  sse = true;
  const res = await add(ADA, { name: "Streamy", url, token: "s3cret" });
  expect(res.status).toBe(201);
  expect(((await res.json()) as any).tools).toHaveLength(2);
});

// ── who, and where to ────────────────────────────────────────────────────

test("only a public https address for a member; private ones for an admin where the operator said so", async () => {
  expect((await add(BEN, { name: "Lan", url })).status).toBe(400);                                  // http
  const inside = await add(BEN, { name: "Lan", url: "https://127.0.0.1:9/mcp" });
  expect(inside.status).toBe(422);
  expect(((await inside.json()) as any).error).toContain("private network");
  expect((await add(BEN, { name: "Lan", url: "https://192.168.1.10/mcp" })).status).toBe(422);
  expect((await add(BEN, { name: "Creds", url: "https://user:pw@example.com/mcp" })).status).toBe(400);
  expect((await add(BEN, { name: "Ftp", url: "ftp://example.com/mcp" })).status).toBe(400);
  expect(calls).toHaveLength(0);
  // Without the operator's word, the admin is held to the same rule.
  delete process.env.MAURICE_MEMBER_TOOLS_PRIVATE;
  expect((await add(ADA, { name: "Lan", url })).status).toBe(400);
  process.env.MAURICE_MEMBER_TOOLS_PRIVATE = "1";
});

test("a redirect is refused, not followed", async () => {
  redirect = true;
  const res = await add(ADA, { name: "Moved", url, token: "s3cret" });
  expect(res.status).toBe(422);
});

test("a guest has no tools of their own, and the operator can switch the whole thing off", async () => {
  expect((await add(GUS, { name: "Mine", url, token: "s3cret" })).status).toBe(403);
  expect(((await (await call(GUS, "/")).json()) as any).allowed).toBe(false);
  process.env.MAURICE_MEMBER_TOOLS = "0";
  try {
    expect((await add(ADA, { name: "Mine", url, token: "s3cret" })).status).toBe(403);
    expect(svc.memberToolsFor(ADA)).toEqual([]);
  } finally {
    delete process.env.MAURICE_MEMBER_TOOLS;
  }
});

test("a member reaches only their own servers", async () => {
  const row = (await (await add(ADA, { name: "Notion", url, token: "s3cret" })).json()) as any;
  expect(((await (await call(BEN, "/")).json()) as any).servers).toEqual([]);
  expect((await call(BEN, `/${row.id}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) })).status).toBe(404);
  expect((await call(BEN, `/${row.id}/refresh`, { method: "POST" })).status).toBe(404);
  expect((await call(BEN, `/${row.id}`, { method: "DELETE" })).status).toBe(404);
  expect(svc.memberToolsFor(BEN)).toEqual([]);
  expect((await svc.runMemberTool("x_notion__search", { q: "a" }, BEN)).isError).toBe(true);
});

test("the same address twice, and more servers than allowed, are refused", async () => {
  expect((await add(ADA, { name: "Notion", url, token: "s3cret" })).status).toBe(201);
  expect((await add(ADA, { name: "Again", url, token: "s3cret" })).status).toBe(409);
  for (let i = 2; i <= svc.MAX_SERVERS; i++) expect((await add(ADA, { name: "Notion", url: `${url}?${i}`, token: "s3cret" })).status).toBe(201);
  expect((await add(ADA, { name: "One more", url: `${url}?more`, token: "s3cret" })).status).toBe(409);
  // Same name, a prefix of its own each.
  const prefixes = ((await (await call(ADA, "/")).json()) as any).servers.map((s: any) => s.prefix);
  expect(new Set(prefixes).size).toBe(svc.MAX_SERVERS);
  expect(prefixes).toContain("x_notion-2");
});

// ── naming and bounds ────────────────────────────────────────────────────

test("tools are named after the server, bounded, and in a stable order", () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ name: `t${String(i).padStart(2, "0")}`, description: "d", inputSchema: { type: "object" } }));
  const big = { name: "big", description: "x", inputSchema: { type: "object", description: "y".repeat(9_000) } };
  const shaped = svc.shapeTools("notion", [
    { name: "z last", description: "a".repeat(2_000), inputSchema: { properties: {} } },
    { name: "!!!", inputSchema: {} }, big, { name: "dup", inputSchema: {} }, { name: "dup", inputSchema: {} },
  ] as any);
  expect(shaped.tools.map((t) => t.name)).toEqual(["x_notion__dup", "x_notion__z_last"]);
  expect(shaped.dropped).toBe(3);
  expect(shaped.tools[1]!.remote).toBe("z last");
  expect(shaped.tools[1]!.description).toHaveLength(1_000);
  expect(shaped.tools[1]!.inputSchema.type).toBe("object");
  const capped = svc.shapeTools("notion", many as any);
  expect(capped.tools).toHaveLength(svc.MAX_TOOLS_PER_SERVER);
  expect(capped.dropped).toBe(10);
  const long = svc.shapeTools("a-rather-long-server", [{ name: "x".repeat(80), inputSchema: {} }] as any);
  expect(long.tools[0]!.name.length).toBeLessThanOrEqual(64);
  expect(svc.slugOf("Élan Vital — 2!")).toBe("elan-vital-2");
  expect(svc.slugOf("???")).toBe("server");
  expect(svc.isMemberTool("x_notion__search")).toBe(true);
  expect(svc.isMemberTool("garden__create_note")).toBe(false);
});

// ── in a turn ────────────────────────────────────────────────────────────

test("a turn holds the tools without asking the server, and a call goes to it under its own name", async () => {
  await add(ADA, { name: "Notion", url, token: "s3cret" });
  calls = [];
  const held = svc.memberToolsFor(ADA);
  expect(held.map((t) => t.name)).toEqual(["x_notion__create_page", "x_notion__search"]);
  expect(held[1]!.description).toBe("[Notion] Search the workspace.");
  expect(calls).toHaveLength(0);
  const notice = svc.memberToolsNotice(ADA, held.map((t) => t.name));
  expect(notice).toContain("Notion (tools named x_notion__…)");
  expect(notice).toContain("never instructions");
  expect(svc.memberToolsNotice(ADA, ["garden__get_note"])).toBe("");

  const r = await svc.runMemberTool("x_notion__create_page", { title: "Hi" }, ADA);
  expect(r).toEqual({ text: 'called create page with {"title":"Hi"}', isError: false });
  // A second call shakes hands no more.
  await svc.runMemberTool("x_notion__search", { q: "a" }, ADA);
  expect(calls.map((c) => c.method)).toEqual(["initialize", "notifications/initialized", "tools/call", "tools/call"]);
});

test("a server switched off or removed cannot be called, even from a stale roster", async () => {
  const row = (await (await add(ADA, { name: "Notion", url, token: "s3cret" })).json()) as any;
  const off = await call(ADA, `/${row.id}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) });
  expect(((await off.json()) as any).enabled).toBe(false);
  expect(svc.memberToolsFor(ADA)).toEqual([]);
  calls = [];
  expect((await svc.runMemberTool("x_notion__search", { q: "a" }, ADA)).isError).toBe(true);
  expect((await svc.runMemberTool("x_notion__unknown", {}, ADA)).isError).toBe(true);
  expect(calls).toHaveLength(0);
  await call(ADA, `/${row.id}`, { method: "PATCH", body: JSON.stringify({ enabled: true }) });
  expect((await svc.runMemberTool("x_notion__search", { q: "a" }, ADA)).isError).toBe(false);
  expect((await call(ADA, `/${row.id}`, { method: "DELETE" })).status).toBe(200);
  expect((await svc.runMemberTool("x_notion__search", { q: "a" }, ADA)).isError).toBe(true);
});

test("a server that stops answering is said as such, without its token", async () => {
  await add(ADA, { name: "Notion", url, token: "s3cret" });
  token = "rotated";
  const r = await svc.runMemberTool("x_notion__search", { q: "a" }, ADA);
  expect(r.isError).toBe(true);
  expect(r.text).toContain('"Notion" did not answer');
  expect(r.text).not.toContain("s3cret");
});

test("a new token is tried first: one that does not work leaves the old one", async () => {
  const row = (await (await add(ADA, { name: "Notion", url, token: "s3cret" })).json()) as any;
  const bad = await call(ADA, `/${row.id}`, { method: "PATCH", body: JSON.stringify({ token: "nope" }) });
  expect(bad.status).toBe(422);
  expect((await svc.runMemberTool("x_notion__search", { q: "a" }, ADA)).isError).toBe(false);
  token = "fresh";
  const good = await call(ADA, `/${row.id}`, { method: "PATCH", body: JSON.stringify({ token: "fresh" }) });
  expect(good.status).toBe(200);
  expect((await svc.runMemberTool("x_notion__search", { q: "a" }, ADA)).isError).toBe(false);
});

test("refreshing reads what the server offers now; a failure keeps the last tools", async () => {
  const row = (await (await add(ADA, { name: "Notion", url, token: "s3cret" })).json()) as any;
  tools = [{ name: "only", description: "The only one." }];
  const again = (await (await call(ADA, `/${row.id}/refresh`, { method: "POST" })).json()) as any;
  expect(again.tools).toEqual([{ name: "only", description: "The only one." }]);
  token = "rotated";
  const failed = (await (await call(ADA, `/${row.id}/refresh`, { method: "POST" })).json()) as any;
  expect(failed.state).toBe("error");
  expect(failed.last_error).toContain("refused the token");
  expect(failed.tools).toHaveLength(1);
});

test("the picker lists a member's servers as theirs, on while the server is", async () => {
  const row = (await (await add(ADA, { name: "Notion", url, token: "s3cret" })).json()) as any;
  const mine = (await families.listFamilies(ADA)).filter((f) => f.id.startsWith("x_"));
  expect(mine).toEqual([{ id: "x_notion", title: "Notion", icon: "puzzlepiece.extension", blurb: expect.stringContaining("127.0.0.1"), count: 2, group: "core", alwaysOn: true }]);
  expect((await families.listFamilies(BEN)).filter((f) => f.id.startsWith("x_"))).toEqual([]);
  expect(families.familyTitles(["x_notion__search", "web_search"])).toEqual(["Web search"]);
  await call(ADA, `/${row.id}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) });
  expect((await families.listFamilies(ADA)).filter((f) => f.id.startsWith("x_"))).toEqual([]);
});

// ── signing in (OAuth) ───────────────────────────────────────────────────

// A second fake: an MCP server that wants a sign-in, and its authorization
// server on the same origin — metadata, registration, token endpoint.
const { createHash } = await import("node:crypto");
let as: ReturnType<typeof Bun.serve>;
let asUrl = "";
let access = "at-1";
let lifetime: number | undefined = 3600;
let metadata = true;
let registered: any[] = [];
let tokenCalls: Record<string, string>[] = [];
let challenges = new Map<string, string>();   // code → code_challenge
let refreshOk = true;

beforeAll(() => {
  as = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const origin = u.origin;
      if (u.pathname === "/.well-known/oauth-protected-resource/mcp" && metadata) {
        return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["read", "write"] });
      }
      if (u.pathname === "/.well-known/oauth-authorization-server" && metadata) {
        return Response.json({ issuer: origin, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`, registration_endpoint: `${origin}/oauth/register`, code_challenge_methods_supported: ["S256"] });
      }
      if ((u.pathname === "/oauth/register" || u.pathname === "/register") && req.method === "POST") {
        const body = await req.json();
        registered.push(body);
        return Response.json({ client_id: `client-${registered.length}` }, { status: 201 });
      }
      if ((u.pathname === "/oauth/token" || u.pathname === "/token") && req.method === "POST") {
        const f = Object.fromEntries(new URLSearchParams(await req.text()));
        tokenCalls.push(f);
        if (f.grant_type === "authorization_code") {
          const challenge = challenges.get(f.code ?? "");
          if (!challenge || createHash("sha256").update(f.code_verifier ?? "").digest("base64url") !== challenge) {
            return Response.json({ error: "invalid_grant", error_description: "the verifier does not match" }, { status: 400 });
          }
          return Response.json({ access_token: access, token_type: "Bearer", refresh_token: "rt-1", ...(lifetime ? { expires_in: lifetime } : {}) });
        }
        if (f.grant_type === "refresh_token" && refreshOk && f.refresh_token?.startsWith("rt-")) {
          access = `at-${Number(access.slice(3)) + 1}`;
          return Response.json({ access_token: access, token_type: "bearer", refresh_token: `rt-${access.slice(3)}`, expires_in: 3600 });
        }
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      if (u.pathname === "/mcp" && req.method === "POST") {
        const body = (await req.json()) as any;
        if (req.headers.get("authorization") !== `Bearer ${access}`) {
          return new Response("sign in", { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` } });
        }
        if (body.id === undefined) return new Response(null, { status: 202 });
        const result = body.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: {} }
          : body.method === "tools/list" ? { tools: [{ name: "whoami", description: "Who is signed in." }] }
          : { content: [{ type: "text", text: `signed in with ${req.headers.get("authorization")!.slice(7)}` }] };
        return Response.json(rpc(body.id, result));
      }
      return new Response("not found", { status: 404 });
    },
  });
  asUrl = `http://127.0.0.1:${as.port}/mcp`;
});
afterAll(() => as.stop(true));

beforeEach(() => {
  svc.resetSignIns();
  access = "at-1";
  lifetime = 3600;
  metadata = true;
  refreshOk = true;
  registered = [];
  tokenCalls = [];
  challenges = new Map();
});

const ORIGIN = { "x-forwarded-proto": "https", "x-forwarded-host": "home.example" };
const start = (who: string, body: unknown) => call(who, "/oauth/start", { method: "POST", body: JSON.stringify(body), headers: ORIGIN });
/** What the service's sign-in page would do: remember the challenge, hand back a code. */
function approve(authorizeUrl: string, code = "code-1"): string {
  const u = new URL(authorizeUrl);
  challenges.set(code, u.searchParams.get("code_challenge")!);
  return `/oauth/callback?code=${code}&state=${encodeURIComponent(u.searchParams.get("state")!)}`;
}

test("a server that wants a sign-in says so, and the sign-in connects it", async () => {
  const plain = await add(ADA, { name: "Linear", url: asUrl });
  expect(plain.status).toBe(428);
  expect(db.query(`SELECT COUNT(*) AS n FROM member_tool_servers`).get()).toEqual({ n: 0 });

  const res = await start(ADA, { name: "Linear", url: asUrl });
  expect(res.status).toBe(200);
  const u = new URL(((await res.json()) as any).authorize_url);
  expect(u.origin + u.pathname).toBe(`http://127.0.0.1:${as.port}/oauth/authorize`);
  expect(Object.fromEntries(u.searchParams)).toMatchObject({
    response_type: "code", client_id: "client-1", code_challenge_method: "S256", resource: asUrl, scope: "read write",
    redirect_uri: "https://home.example/api/tool-servers/oauth/callback",
  });
  expect(u.searchParams.get("state")!.length).toBeGreaterThan(30);
  expect(registered[0]).toMatchObject({ client_name: "Maurice", redirect_uris: ["https://home.example/api/tool-servers/oauth/callback"], token_endpoint_auth_method: "none" });
  // Nothing is kept until the member comes back.
  expect(db.query(`SELECT COUNT(*) AS n FROM member_tool_servers`).get()).toEqual({ n: 0 });

  // The browser comes back, with no session of its own.
  const back = await routes.request(approve(u.toString()), { headers: { "accept-language": "fr-FR" } });
  expect(back.status).toBe(200);
  expect(await back.text()).toContain("Linear est connecté");
  expect(tokenCalls[0]).toMatchObject({ grant_type: "authorization_code", code: "code-1", client_id: "client-1", resource: asUrl, redirect_uri: "https://home.example/api/tool-servers/oauth/callback" });

  const listed = (await (await call(ADA, "/")).json()) as any;
  expect(listed.servers).toHaveLength(1);
  expect(listed.servers[0]).toMatchObject({ name: "Linear", auth: "oauth", state: "ok", has_token: true, tools: [{ name: "whoami", description: "Who is signed in." }] });
  expect(JSON.stringify(listed)).not.toContain("at-1");
  const row = db.query(`SELECT secret, oauth FROM member_tool_servers`).get() as { secret: string; oauth: string };
  expect(row.secret.startsWith("v1:")).toBe(true);
  expect(row.oauth.startsWith("v1:")).toBe(true);
  expect(row.oauth).not.toContain("rt-1");
  expect(await svc.runMemberTool("x_linear__whoami", {}, ADA)).toEqual({ text: "signed in with at-1", isError: false });
});

test("a sign-in is good once, for its own state, and a refusal is shown", async () => {
  const u = ((await (await start(ADA, { name: "Linear", url: asUrl })).json()) as any).authorize_url;
  const path = approve(u);
  expect((await routes.request("/oauth/callback?code=code-1&state=made-up")).status).toBe(400);
  expect((await routes.request(path)).status).toBe(200);
  expect((await routes.request(path)).status).toBe(400);
  const denied = await routes.request("/oauth/callback?error=access_denied&error_description=%3Cb%3Eno%3C/b%3E");
  expect(denied.status).toBe(400);
  expect(await denied.text()).toContain("&#60;b&#62;no");
  expect(db.query(`SELECT COUNT(*) AS n FROM member_tool_servers`).get()).toEqual({ n: 1 });
});

test("a code that does not match the sign-in keeps nothing", async () => {
  const u = new URL(((await (await start(ADA, { name: "Linear", url: asUrl })).json()) as any).authorize_url);
  challenges.set("stolen", "someone-else's-challenge");
  const back = await routes.request(`/oauth/callback?code=stolen&state=${encodeURIComponent(u.searchParams.get("state")!)}`);
  expect(back.status).toBe(400);
  expect(await back.text()).toContain("the verifier does not match");
  expect(db.query(`SELECT COUNT(*) AS n FROM member_tool_servers`).get()).toEqual({ n: 0 });
});

test("the token is renewed before it lapses, and when the server refuses it", async () => {
  lifetime = 30;                                  // lapses within the minute
  const u = ((await (await start(ADA, { name: "Linear", url: asUrl })).json()) as any).authorize_url;
  expect((await routes.request(approve(u))).status).toBe(200);
  // Listing after the exchange already renewed it once: at-1 was about to lapse.
  expect(access).toBe("at-2");
  expect(await svc.runMemberTool("x_linear__whoami", {}, ADA)).toEqual({ text: "signed in with at-2", isError: false });
  // The service drops the token early: one refusal, one renewal, the call again.
  access = "at-7";
  expect(await svc.runMemberTool("x_linear__whoami", {}, ADA)).toEqual({ text: "signed in with at-8", isError: false });
  expect(tokenCalls.filter((c) => c.grant_type === "refresh_token").map((c) => c.refresh_token)).toEqual(["rt-1", "rt-2"]);
  // A sign-in that cannot be renewed is said as such, and the server marked.
  access = "at-20";
  refreshOk = false;
  const lost = await svc.runMemberTool("x_linear__whoami", {}, ADA);
  expect(lost.isError).toBe(true);
  expect(lost.text).toContain("sign in again");
  const id = (db.query(`SELECT id FROM member_tool_servers`).get() as { id: string }).id;
  const marked = (await (await call(ADA, `/${id}/refresh`, { method: "POST" })).json()) as any;
  expect(marked).toMatchObject({ state: "error", auth: "oauth" });
  expect(marked.last_error).toContain("sign in again");

  // Signing in again, for the same server, puts it back.
  refreshOk = true;
  lifetime = 3600;
  const again = await start(ADA, { id });
  expect(again.status).toBe(200);
  access = "at-30";
  expect((await routes.request(approve(((await again.json()) as any).authorize_url, "code-2"))).status).toBe(200);
  expect(await svc.runMemberTool("x_linear__whoami", {}, ADA)).toEqual({ text: "signed in with at-30", isError: false });
  expect(db.query(`SELECT COUNT(*) AS n FROM member_tool_servers`).get()).toEqual({ n: 1 });
});

test("a server that publishes no metadata is signed in to at its own /authorize, /token and /register", async () => {
  metadata = false;
  const u = new URL(((await (await start(ADA, { name: "Old", url: asUrl })).json()) as any).authorize_url);
  expect(u.pathname).toBe("/authorize");
  expect(u.searchParams.get("scope")).toBeNull();
  expect((await routes.request(approve(u.toString()))).status).toBe(200);
  expect(await svc.runMemberTool("x_old__whoami", {}, ADA)).toEqual({ text: "signed in with at-1", isError: false });
});

test("who may sign in, and to what, is held to the same rules as a token", async () => {
  expect((await start(GUS, { name: "Linear", url: asUrl })).status).toBe(403);
  expect((await start(BEN, { name: "Linear", url: asUrl })).status).toBe(400);                       // http, not an admin's
  expect((await start(BEN, { name: "Linear", url: "https://10.0.0.5/mcp" })).status).toBe(422);
  expect((await start(ADA, { name: "Open", url })).status).toBe(422);                                // 401 without a way to sign in… a token server
  token = "";
  expect((await start(ADA, { name: "Open", url })).status).toBe(409);                                // asks for nothing
  expect((await start(BEN, { id: "not-mine" })).status).toBe(404);
  expect(registered).toHaveLength(0);
});

test("a token pasted by hand replaces a sign-in", async () => {
  const u = ((await (await start(ADA, { name: "Linear", url: asUrl })).json()) as any).authorize_url;
  await routes.request(approve(u));
  const id = (db.query(`SELECT id FROM member_tool_servers`).get() as { id: string }).id;
  access = "hand-made";
  const res = await call(ADA, `/${id}`, { method: "PATCH", body: JSON.stringify({ token: "hand-made" }) });
  expect(((await res.json()) as any).auth).toBe("token");
  expect((db.query(`SELECT oauth FROM member_tool_servers`).get() as { oauth: string }).oauth).toBe("");
});
