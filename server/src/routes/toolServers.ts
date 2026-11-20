import { Hono } from "hono";
import { requireAuth } from "../middleware/auth";
import {
  MAX_SERVERS,
  MAX_TOOLS_PER_SERVER,
  MemberToolError,
  addToolServer,
  getToolServer,
  listToolServers,
  mayAddTools,
  refreshToolServer,
  removeToolServer,
  updateToolServer,
  type MemberToolServer,
} from "../services/memberTools";

// The signed-in member's own MCP servers (services/memberTools.ts). Every
// route acts on the caller's servers only; another member's is not found
// rather than refused. The token goes in and never comes back out.
//
// Adding a server asks it for its tools before answering: one that does not
// answer, or refuses the token, is not kept, and its reason is returned now.

const servers = new Hono();

servers.use("/*", requireAuth);

const view = (s: MemberToolServer) => ({
  id: s.id,
  name: s.name,
  prefix: `x_${s.slug}`,
  url: s.url,
  auth_header: s.auth_header,
  has_token: s.has_token,
  enabled: s.enabled,
  state: s.state,
  last_error: s.last_error,
  checked_at: s.checked_at,
  created_at: s.created_at,
  tools: s.tools.map((t) => ({ name: t.remote, description: t.description })),
  dropped: s.dropped,
});

function fail(c: any, err: unknown) {
  if (err instanceof MemberToolError) return c.json({ error: err.message }, err.status);
  throw err;
}

/** The member's servers, whether they may add any, and the limits. */
servers.get("/", (c) => {
  const uid = c.get("userId");
  return c.json({
    servers: listToolServers(uid).map(view),
    allowed: mayAddTools(uid),
    limits: { servers: MAX_SERVERS, tools_per_server: MAX_TOOLS_PER_SERVER },
  });
});

/** Add a server: `{ name, url, token?, auth_header? }`. 201 once it listed its
 *  tools; 422 with the reason when it did not, and nothing is kept. */
servers.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    return c.json(view(await addToolServer(c.get("userId"), body)), 201);
  } catch (err) {
    return fail(c, err);
  }
});

/** Switch a server on or off, rename it, or give it a new token (tried
 *  first: one that does not work leaves the previous one in place). */
servers.patch("/:id", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    return c.json(view(await updateToolServer(c.get("userId"), c.req.param("id"), body)));
  } catch (err) {
    return fail(c, err);
  }
});

/** Ask the server again what it offers. The row says how it went. */
servers.post("/:id/refresh", async (c) => {
  const uid = c.get("userId");
  if (!getToolServer(uid, c.req.param("id"))) return c.json({ error: "Not found" }, 404);
  const s = await refreshToolServer(uid, c.req.param("id"));
  return s ? c.json(view(s)) : c.json({ error: "Not found" }, 404);
});

servers.delete("/:id", (c) => {
  if (!removeToolServer(c.get("userId"), c.req.param("id"))) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

export default servers;
