import { Hono } from "hono";
import { requireAuth } from "../middleware/auth";
import {
  MAX_SERVERS,
  MAX_TOOLS_PER_SERVER,
  MemberToolError,
  addToolServer,
  finishToolSignIn,
  getToolServer,
  listToolServers,
  mayAddTools,
  refreshToolServer,
  removeToolServer,
  startToolSignIn,
  updateToolServer,
  type MemberToolServer,
} from "../services/memberTools";

// The signed-in member's own MCP servers (services/memberTools.ts). Every
// route acts on the caller's servers only; another member's is not found
// rather than refused. The token goes in and never comes back out.
//
// Adding a server asks it for its tools before answering: one that does not
// answer, or refuses the token, is not kept, and its reason is returned now.
//
// A server that wants a sign-in answers the add with 428. The app then asks
// POST /oauth/start where to send the member, opens that address in a
// browser, and the service sends the browser back to GET /oauth/callback —
// the one route here that carries no session: the `state` it brings names the
// sign-in, was handed to the member's app alone, and is good once.

const servers = new Hono();

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const PAGE: Record<string, { ok: string; okBody: string; ko: string; koBody: string }> = {
  en: { ok: "Connected", okBody: "{name} is connected to your Maurice. You can close this page and return to the app.", ko: "The sign-in did not work", koBody: "Return to the app and try again." },
  fr: { ok: "Connecté", okBody: "{name} est connecté à votre Maurice. Vous pouvez fermer cette page et revenir à l'app.", ko: "La connexion n'a pas abouti", koBody: "Revenez à l'app et réessayez." },
  it: { ok: "Collegato", okBody: "{name} è collegato al vostro Maurice. Potete chiudere questa pagina e tornare all'app.", ko: "L'accesso non è riuscito", koBody: "Tornate all'app e riprovate." },
  de: { ok: "Verbunden", okBody: "{name} ist mit Ihrem Maurice verbunden. Sie können diese Seite schließen und zur App zurückkehren.", ko: "Die Anmeldung hat nicht geklappt", koBody: "Kehren Sie zur App zurück und versuchen Sie es erneut." },
  es: { ok: "Conectado", okBody: "{name} está conectado a su Maurice. Puede cerrar esta página y volver a la app.", ko: "El inicio de sesión no funcionó", koBody: "Vuelva a la app e inténtelo de nuevo." },
  pt: { ok: "Ligado", okBody: "{name} está ligado ao seu Maurice. Pode fechar esta página e voltar à app.", ko: "O início de sessão não funcionou", koBody: "Volte à app e tente novamente." },
  nl: { ok: "Verbonden", okBody: "{name} is verbonden met uw Maurice. U kunt deze pagina sluiten en terugkeren naar de app.", ko: "Het aanmelden is niet gelukt", koBody: "Ga terug naar de app en probeer het opnieuw." },
};

function page(c: any, status: 200 | 400, title: string, body: string, detail = "") {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
  return c.html(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>` +
    `<style>body{font:17px/1.5 -apple-system,system-ui,sans-serif;max-width:28rem;margin:18vh auto;padding:0 1.5rem;color:#222;background:#faf8f4}h1{font-size:1.4rem}code{font-size:.8rem;color:#777;word-break:break-word}@media(prefers-color-scheme:dark){body{color:#eee;background:#1b1a18}}</style>` +
    `</head><body><h1>${esc(title)}</h1><p>${esc(body)}</p>${detail ? `<p><code>${esc(detail)}</code></p>` : ""}</body></html>`,
    status,
  );
}

/** Where the service sends the member's browser back. No session: see above. */
servers.get("/oauth/callback", async (c) => {
  const lang = (c.req.header("accept-language") ?? "").slice(0, 2).toLowerCase();
  const t = PAGE[lang] ?? PAGE.en!;
  const refused = c.req.query("error");
  if (refused) return page(c, 400, t.ko, t.koBody, c.req.query("error_description") || refused);
  try {
    const server = await finishToolSignIn(c.req.query("state") ?? "", c.req.query("code") ?? "");
    return page(c, 200, t.ok, t.okBody.replace("{name}", server.name));
  } catch (err) {
    if (err instanceof MemberToolError) return page(c, 400, t.ko, t.koBody, err.message);
    throw err;
  }
});

servers.use("/*", requireAuth);

/** This household as the caller's device reaches it. */
function originOf(c: any): string {
  const url = new URL(c.req.url);
  const proto = (c.req.header("x-forwarded-proto") ?? url.protocol.replace(":", "")).split(",")[0]!.trim();
  const host = (c.req.header("x-forwarded-host") ?? c.req.header("host") ?? url.host).split(",")[0]!.trim();
  return `${proto === "http" ? "http" : "https"}://${host}`;
}

const view = (s: MemberToolServer) => ({
  id: s.id,
  name: s.name,
  prefix: `x_${s.slug}`,
  url: s.url,
  auth_header: s.auth_header,
  auth: s.auth,
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

/** Where to send the member to sign in: `{ name, url }` for a new server,
 *  `{ id }` for one of theirs whose sign-in lapsed. Answers `{ authorize_url }`;
 *  the server appears in the list once they come back through the callback. */
servers.post("/oauth/start", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    return c.json(await startToolSignIn(c.get("userId"), body, originOf(c)));
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
