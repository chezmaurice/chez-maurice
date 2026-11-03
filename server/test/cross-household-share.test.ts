/**
 * Giving an entry to someone in another household (specs/cross-household-share.md).
 *
 *   A. A member invites a friend as their guest: the guest reaches the inviter
 *      alone; a guest may not invite, a child only when the admin allowed it.
 *   B. The export of an entry, element by element, and of a conversation —
 *      only when the caller is its one human.
 *   C. The import: an ordinary fiche in the caller's notes, a draft card,
 *      shared with the friend; a second gift is refused with the coordinates.
 *   E. A conversation sent whole arrives read-only.
 *
 * The two households are played by one database: Anna gives from "A"; in "B"
 * Paul invites her as a guest, and her guest account receives the gift.
 * Run with `bun test` from server/.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Hono } from "hono";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "maurice-cross-household-"));
const GARDENS = path.join(TMP, "gardens");
process.env.MAURICE_GARDENS_DIR = GARDENS;

const { default: db } = await import("../src/db");
const { createSession } = await import("../src/services/auth");
const invites = await import("../src/services/invites");
const auth = (await import("../src/routes/auth")).default;
const me = (await import("../src/routes/me")).default;
const users = (await import("../src/routes/users")).default;
const conversationRoutes = (await import("../src/routes/conversations")).default;
const { default: entries } = await import("../data-api/routes/garden-entries");
const { saveArticleFiche, findArticleFiche } = await import("../data-api/services/gardenArticles");
const { createArticleHighlight } = await import("../data-api/services/articleHighlights");
const { gardenFor, parseFiche, fragmentsDir } = await import("../data-api/services/gardenFiche");
const { addMessage, addParticipant, createConversation } = await import("../src/services/conversations");
const { summariseSettledConversations, setEntryConversationSummarizer } = await import("../data-api/services/entryConversations");
const { getFiche } = await import("../src/services/composer/fiches");

const ANNA = { id: "xh-anna", username: "xhanna" };   // household A, the giver
const ZOE = { id: "xh-zoe", username: "xhzoe" };      // A, another member
const PAUL = { id: "xh-paul", username: "xhpaul" };   // household B, the friend
const KID = { id: "xh-kid", username: "xhkid" };      // B, a child
const OTHER = { id: "xh-other", username: "xhother" }; // B, someone Paul's guest cannot reach

const tokens: Record<string, string> = {};
const bearer = (id: string) => ({ Authorization: `Bearer ${tokens[id] ??= createSession(id).token}`, "Content-Type": "application/json" });

const data = new Hono();
data.use("*", async (c, next) => {
  (c as any).set("userId", c.req.header("x-user"));
  await next();
});
data.route("/", entries);
const { default: articleRoutes } = await import("../data-api/routes/garden-articles");
const articles = new Hono();
articles.use("*", async (c, next) => {
  (c as any).set("userId", c.req.header("x-user"));
  await next();
});
articles.route("/", articleRoutes);
const garden = (who: string, method: string, url: string, body?: unknown) =>
  data.request(url, {
    method, headers: { "x-user": who, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const page = `<!doctype html><html lang="fr"><head>
<title>Le temps long des forêts | Revue</title>
<meta property="og:title" content="Le temps long des forêts">
<meta property="og:site_name" content="Revue">
</head><body><article><h2>Un titre</h2><p>${"Les forêts poussent lentement, et nous pensons vite. ".repeat(40)}</p></article></body></html>`;

let article: any;
let soleConvo = "";
let sharedConvo = "";
let guestId = "";
const PNG = "data:image/png;base64," + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString("base64");

beforeAll(async () => {
  for (const u of [ANNA, ZOE, PAUL, KID, OTHER]) {
    db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, 'standard')`, [u.id, u.username, u.username]);
  }
  db.run(`UPDATE users SET is_child = 1 WHERE id = ?`, [KID.id]);
  for (const username of [ANNA.username, PAUL.username]) {
    const root = path.join(GARDENS, username);
    fs.mkdirSync(root, { recursive: true });
    for (const args of [["init", "-q"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) spawnSync("git", args, { cwd: root });
  }

  // Anna's entry in A: an article with her note, a highlight, a card, and two
  // conversations — one she held alone, one Zoé joined.
  article = await saveArticleFiche(ANNA.id, { url: "https://revue.example/forets-temps-long", html: page, comment: "À relire." });
  const at = `articles/${article.locale}/${article.slug}`;
  expect((await garden(ANNA.id, "POST", `/entries/${at}/notes`, { text: "Le passage sur les chênes." })).status).toBe(201);
  createArticleHighlight(ANNA.id, article.locale, article.slug, { quote: "Les forêts poussent lentement", note: "oui" });
  expect((await garden(ANNA.id, "PUT", `/entries/${at}/shared`, { body: "Un article qui ralentit." })).status).toBeLessThan(300);

  soleConvo = createConversation(ANNA.id, null, { entryRef: at }).id;
  addMessage(soleConvo, "user", "Que dit-il des chênes ?", { authorId: ANNA.id });
  addMessage(soleConvo, "assistant", "Qu'ils vivent plusieurs siècles.", { data: [{ tool: "search", data: { n: 1 } }] });
  sharedConvo = createConversation(ANNA.id, null, { entryRef: at }).id;
  addParticipant(sharedConvo, ZOE.id, "member");
  addMessage(sharedConvo, "user", "Zoé, tu as lu ?", { authorId: ANNA.id });
  addMessage(sharedConvo, "user", "Oui !", { authorId: ZOE.id });
});

afterAll(() => {
  setEntryConversationSummarizer(null);
  const ids = [ANNA.id, ZOE.id, PAUL.id, KID.id, OTHER.id, guestId].filter(Boolean);
  db.run(`DELETE FROM entry_shares WHERE owner_id IN (${ids.map(() => "?").join(",")})`, ids);
  db.run(`DELETE FROM conversations WHERE user_id IN (${ids.map(() => "?").join(",")})`, ids);
  db.run(`DELETE FROM household_invites WHERE contact_of IN (${ids.map(() => "?").join(",")})`, ids);
  db.run(`DELETE FROM users WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ── A ──

describe("a member invites a friend as a guest", () => {
  test("a member may; a guest may not; a child only when the admin allowed it", async () => {
    const made = await me.request("/guest-invite", { method: "POST", headers: bearer(PAUL.id) });
    expect(made.status).toBe(201);
    const body = (await made.json()) as any;
    expect(body.code).toMatch(/^[A-Z0-9]{8}$/);
    expect(body.link).toContain(`/join?code=${body.code}`);
    expect(typeof body.expires_at).toBe("string");

    expect((await me.request("/guest-invite", { method: "POST", headers: bearer(KID.id) })).status).toBe(403);
    db.run(`UPDATE users SET may_invite_guests = 1 WHERE id = ?`, [KID.id]);
    expect((await me.request("/guest-invite", { method: "POST", headers: bearer(KID.id) })).status).toBe(201);

    const list = (await (await me.request("/guest-invites", { headers: bearer(PAUL.id) })).json()) as any;
    expect(list.allowed).toBe(true);
    expect(list.invites.map((i: any) => i.code)).toContain(body.code);
    // The admin's list of open invitations is theirs alone: member-made guest invitations are not in it.
    expect(invites.listOpenInvites().map((i) => i.code)).not.toContain(body.code);

    expect(((await (await me.request(`/guest-invites/${body.code}`, { headers: bearer(PAUL.id) })).json()) as any).state).toBe("pending");
    expect((await me.request(`/guest-invites/${body.code}`, { headers: bearer(ANNA.id) })).status).toBe(404);
    expect((await me.request(`/guest-invites/${body.code}`, { method: "DELETE", headers: bearer(ANNA.id) })).status).toBe(404);
    expect((await me.request(`/guest-invites/${body.code}`, { method: "DELETE", headers: bearer(PAUL.id) })).status).toBe(200);
    expect(invites.isOpenInvite(body.code)).toBe(false);
  });

  test("redeemed, it makes a guest whose one contact is the inviter, without a PIN", async () => {
    const { code } = invites.createGuestInvite(PAUL.id);
    const enroll = (b: unknown) => auth.request("/enroll", {
      method: "POST", headers: { "Content-Type": "application/json", "x-forwarded-for": "10.9.9.9" }, body: JSON.stringify(b),
    });
    const asked = (await (await enroll({ code })).json()) as any;
    expect(asked.needs_profile).toBe(true);
    expect(asked.role).toBe("guest");
    expect(asked.invited_by).toBe(PAUL.username);

    const joined = (await (await enroll({ code, display_name: "Anna chez Paul" })).json()) as any;
    expect(joined.role).toBe("guest");
    expect(joined.needs_pin).toBe(false);
    guestId = joined.user_id;
    expect(db.query(`SELECT role FROM users WHERE id = ?`).get(guestId)).toEqual({ role: "guest" });
    expect(db.query(`SELECT member_id FROM guest_contacts WHERE guest_user_id = ?`).all(guestId)).toEqual([{ member_id: PAUL.id }]);
    expect(invites.invitedBy(guestId)?.id).toBe(PAUL.id);
    expect(invites.guestsInvitedBy(PAUL.id).map((g) => g.id)).toContain(guestId);
    expect(invites.guestInviteState(PAUL.id, code)).toBe("used");

    // Their roster: themselves and Paul.
    tokens[guestId] = joined.token;
    const roster = (await (await users.request("/", { headers: bearer(guestId) })).json()) as any[];
    expect(roster.map((u) => u.id).sort()).toEqual([guestId, PAUL.id].sort());

    // A guest does not invite.
    expect((await me.request("/guest-invite", { method: "POST", headers: bearer(guestId) })).status).toBe(403);
  });
});

// ── B ──

let exported: any;

describe("the export of an entry", () => {
  test("element by element, the member's own", async () => {
    const at = `articles/${article.locale}/${article.slug}`;
    const res = await garden(ANNA.id, "GET", `/entries/${at}/export`);
    expect(res.status).toBe(200);
    exported = await res.json();
    expect(exported.entry).toMatchObject({ collection: "articles", slug: article.slug, title: "Le temps long des forêts", kind: "articles" });
    expect(exported.entry.meta.opened).toBeUndefined();
    expect(exported.source.kind).toBe("article");
    expect(exported.source.url).toBe("https://revue.example/forets-temps-long");
    expect(exported.source.text).toContain("Les forêts poussent lentement");
    expect(Array.isArray(exported.source.styles)).toBe(true);
    expect(exported.fiche.notes.map((n: any) => n.text)).toContain("Le passage sur les chênes.");
    expect(exported.fiche.notes[0].id).toMatch(/^n\d+-[0-9a-f]{8}$/);
    expect(exported.highlights).toHaveLength(1);
    expect(exported.highlights[0]).toMatchObject({ text: "Les forêts poussent lentement", note: "oui" });
    expect(exported.card).toMatchObject({ body: "Un article qui ralentit.", status: "draft" });
    const byId = new Map(exported.conversations.map((c: any) => [c.id, c]));
    expect((byId.get(soleConvo) as any).shareable).toBe(true);
    expect((byId.get(sharedConvo) as any)).toMatchObject({ shareable: false, reason: "others_took_part" });
  });

  test("not someone else's entry, even shared with the caller", async () => {
    const at = `articles/${article.locale}/${article.slug}`;
    expect((await garden(ZOE.id, "GET", `/entries/${at}/export?owner=${ANNA.username}`)).status).toBe(403);
    expect((await garden(ZOE.id, "GET", `/entries/${at}/export`)).status).toBe(404);
  });

  test("a conversation leaves only when the caller is its one human", async () => {
    const ok = await conversationRoutes.request(`/${soleConvo}/export`, { headers: bearer(ANNA.id) });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as any;
    expect(body.messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
    expect(body.messages[1].data).toEqual([{ tool: "search", data: { n: 1 } }]);
    expect(body.messages[1].author).toBe("Maurice");
    expect((await conversationRoutes.request(`/${sharedConvo}/export`, { headers: bearer(ANNA.id) })).status).toBe(403);
    expect((await conversationRoutes.request(`/${soleConvo}/export`, { headers: bearer(ZOE.id) })).status).toBe(404);
    exported.whole = body;
  });
});

// ── C and E ──

describe("the import, in the other household", () => {
  let ref: { collection: string; locale: string; slug: string };

  test("an ordinary fiche in the caller's notes, a draft card, shared with the friend", async () => {
    // A guest's notes folder, a repository like any member's.
    const root = gardenFor(guestId)!.root;
    fs.mkdirSync(root, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: root });

    const res = await garden(guestId, "POST", "/entries/import", {
      entry: { ...exported.entry, cover: PNG },
      source: exported.source,
      prose: "",
      notes: exported.fiche.notes,
      highlights: exported.highlights.map((h: any) => ({ ...h, id: 7 })),
      card: { ...exported.card, status: "published" },
      conversations: [
        { id: soleConvo, mode: "whole", title: exported.whole.title, date: exported.whole.date, summary: "Les chênes vivent des siècles.", messages: exported.whole.messages },
        { id: "other", mode: "summary", title: "Une autre", date: "2026-03-15", summary: "On a parlé du climat." },
      ],
      share_with: PAUL.id,
      from_household: "Foyer Dupont",
    });
    expect(res.status).toBe(201);
    ref = (await res.json()) as any;
    expect(ref.collection).toBe("articles");

    const g = gardenFor(guestId)!;
    const own = findArticleFiche(g, "https://revue.example/forets-temps-long")!;
    const parsed = parseFiche(fs.readFileSync(own.file, "utf-8"))!;
    const meta = parsed.frontmatter.meta as any;
    expect(meta.shared_by).toBe(gardenFor(guestId)!.username);
    expect(meta.given_from).toBe("Foyer Dupont");
    expect(meta.opened).toBeUndefined(); // notes came with it: opened, or they would not show
    expect(meta.image).toMatch(/^\/images\//);
    expect(parsed.body).toContain("Le passage sur les chênes.");
    expect(parsed.body).toContain("> Les forêts poussent lentement");
    expect(parsed.body).toContain("Conversation avec Maurice, 2026-03-15 — On a parlé du climat.");
    expect(fs.readFileSync(path.join(fragmentsDir(own.file), "001.frag"), "utf-8")).toContain("Les forêts poussent lentement");

    const detail = (await (await garden(guestId, "GET", `/entries/${ref.collection}/${ref.locale}/${ref.slug}`)).json()) as any;
    expect(detail.shared.state).toBe("draft");
    expect(detail.shared.body).toContain("Un article qui ralentit.");
    expect(detail.participants.map((p: any) => p.id)).toEqual([PAUL.id]);
    // Shared live, not given as a copy: Paul has none of his own.
    expect(findArticleFiche(gardenFor(PAUL.id)!, "https://revue.example/forets-temps-long")).toBeNull();
  });

  test("the friend finds the article on his shelf, reads it, sees her notes and writes his own", async () => {
    const owner = gardenFor(guestId)!.username;
    const id = `@${owner}/${ref.collection}/${ref.locale}/${ref.slug}`;
    const shelf = (await (await garden(PAUL.id, "GET", "/entries?view=shelf")).json()) as any;
    const row = shelf.entries.find((e: any) => e.id === id);
    expect(row).toBeTruthy();
    expect(row.source.captured).toBe(true);

    const text = await articles.request(`/${ref.slug}/text?locale=${ref.locale}&owner=${owner}`, { headers: { "x-user": PAUL.id } });
    expect(text.status).toBe(200);
    expect(((await text.json()) as any).text).toContain("Les forêts poussent lentement");
    // Not someone it is not shared with.
    expect((await articles.request(`/${ref.slug}/text?locale=${ref.locale}&owner=${owner}`, { headers: { "x-user": OTHER.id } })).status).toBe(404);

    const at = `/entries/${ref.collection}/${ref.locale}/${ref.slug}?owner=${owner}`;
    const seen = (await (await garden(PAUL.id, "GET", at)).json()) as any;
    expect(seen.source.captured).toBe(true);
    expect(seen.mine.items.map((i: any) => i.text)).toContain("Le passage sur les chênes.");

    const wrote = await garden(PAUL.id, "POST", `/entries/${ref.collection}/${ref.locale}/${ref.slug}/notes?owner=${owner}`, { text: "Et les hêtres, alors ?" });
    expect(wrote.status).toBe(201);
    const after = (await wrote.json()) as any;
    const mine = after.mine.items.find((i: any) => i.text === "Et les hêtres, alors ?");
    expect(mine.author.id).toBe(PAUL.id);
    // Written on her fiche, signed.
    const fiche = findArticleFiche(gardenFor(guestId)!, "https://revue.example/forets-temps-long")!;
    expect(fs.readFileSync(fiche.file, "utf-8")).toContain(`@${PAUL.username} — Et les hêtres, alors ?`);
  });

  test("the conversation sent whole is read-only, with both of them in it, on the fiche", async () => {
    const row = db.query(`SELECT id, imported_from, read_only, entry_ref FROM conversations WHERE user_id = ? AND read_only = 1`).get(guestId) as any;
    expect(row).toMatchObject({ imported_from: "Foyer Dupont", read_only: 1, entry_ref: `${ref.collection}/${ref.locale}/${ref.slug}` });
    const seen = (await (await conversationRoutes.request(`/${row.id}`, { headers: bearer(PAUL.id) })).json()) as any;
    expect(seen.read_only).toBe(true);
    expect(seen.imported_from).toBe("Foyer Dupont");
    expect(seen.messages.map((m: any) => m.content)).toEqual(["Que dit-il des chênes ?", "Qu'ils vivent plusieurs siècles."]);
    expect(seen.messages[1].data).toEqual([{ tool: "search", data: { n: 1 } }]);
    expect(seen.participants.map((p: any) => p.member_id).sort()).toEqual([guestId, PAUL.id].sort());
    // The friend sees the entry it is held from, by Carnet's id for a shared entry.
    expect(seen.entry.ref).toBe(`@${gardenFor(guestId)!.username}/${ref.collection}/${ref.locale}/${ref.slug}`);
    const listed = (await (await conversationRoutes.request(`/`, { headers: bearer(PAUL.id) })).json()) as any[];
    expect(listed.find((c) => c.id === row.id)?.read_only).toBe(true);

    const send = await conversationRoutes.request(`/${row.id}/messages`, {
      method: "POST", headers: bearer(PAUL.id), body: JSON.stringify({ content: "Et les hêtres ?" }),
    });
    expect(send.status).toBe(409);

    // Filed on the fiche with the summary it came with, current.
    const about = (await (await garden(guestId, "GET", `/entries/${ref.collection}/${ref.locale}/${ref.slug}/conversations`)).json()) as any;
    const filed = about.conversations.find((c: any) => c.id === row.id);
    expect(filed.summary.text).toBe("Les chênes vivent des siècles.");
    expect(filed.summary.stale).toBe(false);

    // The sweep never summarises it again (Anna's own, in A, it may).
    const asked: string[] = [];
    setEntryConversationSummarizer(async (input) => { asked.push(input.transcript); return { text: "x", usage: null }; });
    await summariseSettledConversations(Date.now() + 3600_000);
    expect(asked.some((t) => t.includes("Anna chez Paul"))).toBe(false);
  });

  test("the friend opens a new conversation from the shared entry, its fiche as context", async () => {
    const id = `@${gardenFor(guestId)!.username}/${ref.collection}/${ref.locale}/${ref.slug}`;
    const res = await conversationRoutes.request("/", { method: "POST", headers: bearer(PAUL.id), body: JSON.stringify({ entry: id }) });
    expect(res.status).toBe(201);
    const convo = (await res.json()) as any;
    expect(convo.entry_ref).toBe(id);
    expect(getFiche(PAUL.id, `${id}-fiche`)?.title).toBe("Le temps long des forêts");
    expect(getFiche(OTHER.id, `${id}-fiche`)).toBeNull();
    const seen = (await (await conversationRoutes.request(`/${convo.id}`, { headers: bearer(PAUL.id) })).json()) as any;
    expect(seen.entry.ref).toBe(id);
    // Someone it is not shared with cannot hold a conversation from it.
    expect((await conversationRoutes.request("/", { method: "POST", headers: bearer(OTHER.id), body: JSON.stringify({ entry: id }) })).status).toBe(404);
  });

  test("given again, it is already there: 409 with where", async () => {
    const res = await garden(guestId, "POST", "/entries/import", {
      entry: exported.entry, source: exported.source, from_household: "Foyer Dupont",
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "exists", ...ref });
  });

  test("not to someone the guest cannot reach; a summary-only gift of a work; bad input", async () => {
    const film = { collection: "movies", locale: "fr", slug: "le-chene", title: "Le Chêne" };
    const blocked = await garden(guestId, "POST", "/entries/import", { entry: film, share_with: OTHER.username, from_household: "Foyer Dupont" });
    expect(blocked.status).toBe(403);
    expect(((await blocked.json()) as any).error).toContain("reach");
    expect(fs.existsSync(path.join(gardenFor(guestId)!.root, "movies"))).toBe(false); // nothing written

    expect((await garden(guestId, "POST", "/entries/import", { entry: film })).status).toBe(400);
    expect((await garden(guestId, "POST", "/entries/import", { entry: { ...film, collection: "notes" }, from_household: "X" })).status).toBe(400);

    const ok = await garden(guestId, "POST", "/entries/import", { entry: film, share_with: PAUL.username, from_household: "Foyer Dupont" });
    expect(ok.status).toBe(201);
    const made = (await ok.json()) as any;
    const detail = (await (await garden(PAUL.id, "GET", `/entries/movies/fr/${made.slug}?owner=${gardenFor(guestId)!.username}`)).json()) as any;
    expect(detail.title).toBe("Le Chêne");
    expect(detail.mine.opened).toBe(false); // nothing of hers came with it
  });

  test("a conversation sent whole without a summary is not summarised here", async () => {
    const film = { collection: "movies", locale: "fr", slug: "les-hetres", title: "Les Hêtres" };
    const res = await garden(guestId, "POST", "/entries/import", {
      entry: film, from_household: "Foyer Dupont",
      conversations: [{ id: "c", mode: "whole", title: "Hêtres", messages: [
        { role: "user", text: "Et les hêtres ?" }, { role: "assistant", text: "Ils aiment l'ombre." },
      ] }],
    });
    expect(res.status).toBe(201);
    const asked: string[] = [];
    setEntryConversationSummarizer(async (input) => { asked.push(input.transcript); return { text: "x", usage: null }; });
    await summariseSettledConversations(Date.now() + 3600_000);
    expect(asked.some((t) => t.includes("hêtres"))).toBe(false);
  });
});
