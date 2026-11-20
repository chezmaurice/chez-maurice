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
