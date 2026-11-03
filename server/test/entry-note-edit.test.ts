/**
 * Changing a note once written: PATCH and DELETE on
 * /entries/:c/:l/:s/notes/:id, the id every note carries, and who may do what
 * — on one's own entry and on one shared with one. Through the routes, since
 * the question is what a member is told. Run with `bun test`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Hono } from "hono";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "maurice-note-edit-"));
const GARDENS = path.join(TMP, "gardens");
process.env.MAURICE_GARDENS_DIR = GARDENS;

const { default: routes } = await import("../data-api/routes/garden-entries");
const { MEMBER } = await import("./_member");
const { default: db } = await import("../src/db");

const SHAREE = { id: "edit-aline", username: "aline-edit" };
const GUEST = { id: "edit-invite", username: "invite-edit" };
const STRANGER = { id: "edit-emilio", username: "emilio-edit" };

const app = new Hono();
app.use("*", async (c, next) => {
  (c as any).set("userId", c.req.header("x-user"));
  await next();
});
app.route("/", routes);

const call = (who: { id: string }, method: string, url: string, body?: unknown) =>
  app.request(url, {
    method,
    headers: { "x-user": who.id, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async (r: Response) => (await r.json()) as any;

const SLUG = "jardin-edit";
const ENTRY = `/entries/books/fr/${SLUG}`;
const OWNER_Q = `?owner=${MEMBER.username}`;
const root = (username: string) => path.join(GARDENS, username);
const FICHE = () => path.join(root(MEMBER.username), `books/fr/${SLUG}-fiche.md`);
const fiche = () => fs.readFileSync(FICHE(), "utf-8");
const today = new Date().toISOString().slice(0, 10);

const notesOf = async (who: { id: string }, query = "") =>
  (await json(await call(who, "GET", `${ENTRY}${query}`))).mine.items
    .filter((i: any) => i.kind === "note" || i.kind === "quote");
const find = async (who: { id: string }, needle: string, query = "") =>
  (await notesOf(who, query)).find((n: any) => `${n.text}\n${n.quote ?? ""}`.includes(needle));
const commits = () =>
  Number(spawnSync("git", ["rev-list", "--count", "HEAD"], { cwd: root(MEMBER.username) }).stdout.toString().trim() || 0);

const BODY = `
Ce que j'en pense, en prose.

## Commentaire

Le mot gardé avec l'article.

2026-10-01 — Première note.

2026-10-02 — Deux fois la même.

2026-10-02 — Deux fois la même.

2026-10-03 — p. 12 :

> Une phrase du livre.

Ce qu'elle dit.

2026-10-04 — @${SHAREE.username} — Une note d'Aline.

2026-10-05 — Gardée d'une conversation. *([Conversation avec Maurice](maurice://conversations/edit-convo))*

2026-10-06 — Conversation avec Maurice, 2026-10-06 — ce qui en est sorti.

## Résonances

2026-10-07 — de [[autre-fiche|Autre]] :

Une résonance.
`;

beforeAll(() => {
  process.env.MAURICE_GARDENS_DIR = GARDENS;
  db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, 'standard')`, [SHAREE.id, SHAREE.username, SHAREE.username]);
  db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, 'guest')`, [GUEST.id, GUEST.username, GUEST.username]);
  db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, 'standard')`, [STRANGER.id, STRANGER.username, STRANGER.username]);
  for (const username of [MEMBER.username, SHAREE.username, GUEST.username, STRANGER.username]) {
    fs.mkdirSync(root(username), { recursive: true });
    for (const args of [["init", "-q"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) {
      spawnSync("git", args, { cwd: root(username) });
    }
  }
  fs.mkdirSync(path.dirname(FICHE()), { recursive: true });
  fs.writeFileSync(FICHE(),
    `---\ntitle: Jardin\nresource_collection: books\nresource_id: ${SLUG}\ndate: '2026-09-01'\ntags: []\nlocale: fr\nopened: true\nmeta:\n  author: Gilles Clément\n---\n${BODY}`);
  // What Maurice filed from a conversation: a fragment beside the fiche.
  const frags = path.join(root(MEMBER.username), `books/fr/${SLUG}-fiche/_fragments`);
  fs.mkdirSync(frags, { recursive: true });
  fs.writeFileSync(path.join(frags, "001.frag"), `---\nsummary: Un fragment\n---\nCe que Maurice a classé.\n`);
  spawnSync("git", ["add", "-A"], { cwd: root(MEMBER.username) });
  spawnSync("git", ["commit", "-qm", "seed"], { cwd: root(MEMBER.username) });
  for (const who of [SHAREE, GUEST]) {
    db.run(`INSERT OR IGNORE INTO entry_shares (owner_id, collection, locale, slug, member_id) VALUES (?, 'books', 'fr', ?, ?)`,
      [MEMBER.id, SLUG, who.id]);
  }
});

afterAll(() => {
  db.run(`DELETE FROM entry_shares WHERE owner_id = ? AND slug = ?`, [MEMBER.id, SLUG]);
  db.run(`DELETE FROM users WHERE id IN (?, ?, ?)`, [SHAREE.id, GUEST.id, STRANGER.id]);
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("every note carries an id and what the reader may do with it", () => {
  test("the owner's page", async () => {
    const notes = await notesOf(MEMBER);
    for (const n of notes) {
      expect(n.id).toMatch(/^n-[0-9a-f]{12}-\d+$/);
      expect(n.edited).toBeNull();
    }
    expect(new Set(notes.map((n: any) => n.id)).size).toBe(notes.length);
    const by = (s: string) => notes.find((n: any) => (n.text || "").includes(s) || (n.quote || "").includes(s));
    expect([by("Première").editable, by("Première").deletable]).toEqual([true, true]);
    expect([by("Une phrase du livre").editable, by("Une phrase du livre").deletable]).toEqual([true, true]);
    // Signed by someone else: the owner takes it off, does not rewrite it.
    expect([by("Une note d'Aline").editable, by("Une note d'Aline").deletable]).toEqual([false, true]);
    // What Maurice put there, and the undated comment of the save: neither.
    for (const s of ["Gardée d'une conversation", "ce qui en est sorti", "Le mot gardé"]) {
      expect([by(s).editable, by(s).deletable]).toEqual([false, false]);
    }
    // Two identical blocks: told apart by their occurrence.
    const twins = notes.filter((n: any) => n.text === "Deux fois la même.").map((n: any) => n.id.split("-").at(-1)).sort();
    expect(twins).toEqual(["0", "1"]);
  });

  test("a sharee's page: only what they signed", async () => {
    const notes = await notesOf(SHAREE, OWNER_Q);
    const rights = Object.fromEntries(notes.map((n: any) => [n.text || n.quote, [n.editable, n.deletable]]));
    expect(rights["Une note d'Aline."]).toEqual([true, true]);
    expect(rights["Première note."]).toEqual([false, false]);
    // The same ids whoever reads.
    expect(notes.map((n: any) => n.id).sort()).toEqual((await notesOf(MEMBER)).map((n: any) => n.id).sort());
  });

  test("the notes view gives the same ids and rights", async () => {
    const page = await notesOf(MEMBER);
    const list = (await json(await call(MEMBER, "GET", "/entries?view=notes"))).notes
      .filter((n: any) => n.entry_id === `books/fr/${SLUG}` && (n.kind === "note" || n.kind === "quote"));
    expect(list.length).toBe(page.length);
    for (const n of list) {
      const same = page.find((p: any) => p.id === n.id);
      expect(same).toBeTruthy();
      expect([n.editable, n.deletable, n.edited]).toEqual([same.editable, same.deletable, same.edited]);
    }
  });

  test("ids do not move when another note is added or taken off", async () => {
    const before = (await notesOf(MEMBER)).map((n: any) => n.id).sort();
    expect((await call(MEMBER, "POST", `${ENTRY}/notes`, { text: "Une note de passage." })).status).toBe(201);
    const passing = await find(MEMBER, "Une note de passage");
    const during = (await notesOf(MEMBER)).map((n: any) => n.id);
    for (const id of before) expect(during).toContain(id);
    expect((await call(MEMBER, "DELETE", `${ENTRY}/notes/${passing.id}`)).status).toBe(204);
    expect((await notesOf(MEMBER)).map((n: any) => n.id).sort()).toEqual(before);
  });
});

describe("editing a note", () => {
  test("the owner rewrites theirs: same date, today's mark, a new id", async () => {
    const note = await find(MEMBER, "Première note");
    const n = commits();
    const res = await call(MEMBER, "PATCH", `${ENTRY}/notes/${note.id}`, { text: "Première note, revue." });
    expect(res.status).toBe(200);
    const { note: out } = await json(res);
    expect(out.date).toBe("2026-10-01");
    expect(out.text).toBe("Première note, revue.");
    expect(out.edited).toBe(today);
    expect(out.author.username).toBe(MEMBER.username);
    expect([out.editable, out.deletable, out.quote, out.page]).toEqual([true, true, null, null]);
    expect(out.id).not.toBe(note.id);
    expect(fiche()).toContain(`2026-10-01 — Première note, revue. *(modifiée le ${today})*`);
    expect(fiche()).not.toContain("2026-10-01 — Première note.\n");
    // Read back the same: the mark is the note's `edited`, not its text.
    const again = await find(MEMBER, "Première note, revue");
    expect([again.id, again.text, again.edited]).toEqual([out.id, "Première note, revue.", today]);
    // Committed in the owner's garden.
    expect(commits()).toBe(n + 1);
  });

  test("an edit sent with the old mark does not stack marks", async () => {
    const note = await find(MEMBER, "Première note, revue");
    const res = await call(MEMBER, "PATCH", `${ENTRY}/notes/${note.id}`, { text: `Première note, revue. *(modifiée le 2026-10-20)*` });
    expect(res.status).toBe(200);
    expect(fiche().match(/modifiée le/g)!.length).toBe(1);
  });

  test("the body is the whole note: quote and page sent are kept, left out are taken off", async () => {
    const note = await find(MEMBER, "Une phrase du livre");
    const res = await call(MEMBER, "PATCH", `${ENTRY}/notes/${note.id}`,
      { text: "Ce qu'elle dit vraiment.", quote: "Une phrase du livre.", page: "12" });
    const { note: out } = await json(res);
    expect([out.quote, out.page, out.text]).toEqual(["Une phrase du livre.", "12", "Ce qu'elle dit vraiment."]);
    expect(fiche()).toContain(`2026-10-03 — p. 12 :\n\n> Une phrase du livre.\n\nCe qu'elle dit vraiment. *(modifiée le ${today})*`);

    const moved = await json(await call(MEMBER, "PATCH", `${ENTRY}/notes/${out.id}`, { text: "", quote: "Une phrase du livre.", page: "13" }));
    expect([moved.note.page, moved.note.text, moved.note.edited]).toEqual(["13", "", today]);
    // A quote alone: the mark on its own line, and the parser takes it back.
    expect(fiche()).toContain(`2026-10-03 — p. 13 :\n\n> Une phrase du livre.\n\n*(modifiée le ${today})*`);
    const back = await find(MEMBER, "Une phrase du livre");
    expect([back.kind, back.text, back.quote, back.edited]).toEqual(["quote", "", "Une phrase du livre.", today]);

    // Quote and page cleared: absent from the body, gone from the note.
    const bare = await json(await call(MEMBER, "PATCH", `${ENTRY}/notes/${back.id}`, { text: "Plus de citation." }));
    expect([bare.note.kind ?? "note", bare.note.quote, bare.note.page, bare.note.text]).toEqual(["note", null, null, "Plus de citation."]);
    expect(fiche()).toContain(`2026-10-03 — Plus de citation. *(modifiée le ${today})*`);
    expect(fiche()).not.toContain("> Une phrase du livre.");
  });

  test("empty text with no quote is refused", async () => {
    const note = await find(MEMBER, "Première note, revue");
    expect((await call(MEMBER, "PATCH", `${ENTRY}/notes/${note.id}`, { text: "  " })).status).toBe(400);
    expect((await call(MEMBER, "PATCH", `${ENTRY}/notes/${note.id}`, { text: "", quote: "" })).status).toBe(400);
  });

  test("a stale id: note_not_found, and the client reloads", async () => {
    const note = await find(MEMBER, "Première note, revue");
    await call(MEMBER, "PATCH", `${ENTRY}/notes/${note.id}`, { text: "Première note, encore." });
    for (const method of ["PATCH", "DELETE"]) {
      const res = await call(MEMBER, method, `${ENTRY}/notes/${note.id}`, method === "PATCH" ? { text: "Trop tard." } : undefined);
      expect(res.status).toBe(404);
      expect((await json(res)).error).toBe("note_not_found");
    }
    expect((await call(MEMBER, "PATCH", `${ENTRY}/notes/n-000000000000-0`, { text: "x" })).status).toBe(404);
  });
});

describe("who may do what", () => {
  test("the owner does not rewrite a note another member signed", async () => {
    const aline = await find(MEMBER, "Une note d'Aline");
    expect((await call(MEMBER, "PATCH", `${ENTRY}/notes/${aline.id}`, { text: "Réécrite." })).status).toBe(403);
    expect(fiche()).toContain(`— @${SHAREE.username} — Une note d'Aline.`);
  });

  test("a sharee rewrites what they signed — still signed — and nothing else", async () => {
    const aline = await find(SHAREE, "Une note d'Aline", OWNER_Q);
    const res = await call(SHAREE, "PATCH", `${ENTRY}/notes/${aline.id}${OWNER_Q}`, { text: "Une note d'Aline, mieux dite." });
    expect(res.status).toBe(200);
    const { note } = await json(res);
    expect([note.author.username, note.editable, note.deletable, note.edited]).toEqual([SHAREE.username, true, true, today]);
    expect(fiche()).toContain(`2026-10-04 — @${SHAREE.username} — Une note d'Aline, mieux dite. *(modifiée le ${today})*`);

    const owners = await find(SHAREE, "Première note", OWNER_Q);
    expect((await call(SHAREE, "PATCH", `${ENTRY}/notes/${owners.id}${OWNER_Q}`, { text: "Non." })).status).toBe(403);
    expect((await call(SHAREE, "DELETE", `${ENTRY}/notes/${owners.id}${OWNER_Q}`)).status).toBe(403);
    // Without `?owner=`, the entry is looked for in the sharee's own garden.
    expect((await call(SHAREE, "PATCH", `${ENTRY}/notes/${owners.id}`, { text: "Non." })).status).toBe(404);
  });

  test("a guest the entry is shared with follows the same rules", async () => {
    expect((await call(GUEST, "POST", `${ENTRY}/notes${OWNER_Q}`, { text: "Le mot de l'invité." })).status).toBe(201);
    const mine = await find(GUEST, "Le mot de l'invité", OWNER_Q);
    expect([mine.editable, mine.deletable]).toEqual([true, true]);
    const edited = await call(GUEST, "PATCH", `${ENTRY}/notes/${mine.id}${OWNER_Q}`, { text: "Le mot de l'invité, revu." });
    expect(edited.status).toBe(200);
    const aline = await find(GUEST, "Une note d'Aline", OWNER_Q);
    expect([aline.editable, aline.deletable]).toEqual([false, false]);
    expect((await call(GUEST, "DELETE", `${ENTRY}/notes/${aline.id}${OWNER_Q}`)).status).toBe(403);
    const revised = await find(GUEST, "Le mot de l'invité, revu", OWNER_Q);
    expect((await call(GUEST, "DELETE", `${ENTRY}/notes/${revised.id}${OWNER_Q}`)).status).toBe(204);
    expect(fiche()).not.toContain("Le mot de l'invité");
  });

  test("a member the entry is not shared with is told nothing", async () => {
    const note = await find(MEMBER, "Première note");
    expect((await call(STRANGER, "PATCH", `${ENTRY}/notes/${note.id}${OWNER_Q}`, { text: "x" })).status).toBe(404);
    expect((await call(STRANGER, "DELETE", `${ENTRY}/notes/${note.id}${OWNER_Q}`)).status).toBe(404);
  });

  test("what Maurice put on the fiche is not a note for these routes", async () => {
    for (const s of ["Gardée d'une conversation", "ce qui en est sorti", "Le mot gardé"]) {
      const n = await find(MEMBER, s);
      expect((await call(MEMBER, "PATCH", `${ENTRY}/notes/${n.id}`, { text: "x" })).status).toBe(403);
      expect((await call(MEMBER, "DELETE", `${ENTRY}/notes/${n.id}`)).status).toBe(403);
    }
    // A fragment's id and a résonance are not notes at all.
    expect((await call(MEMBER, "DELETE", `${ENTRY}/notes/f:001`)).status).toBe(404);
    const text = fiche();
    expect(text).toContain("maurice://conversations/edit-convo");
    expect(text).toContain("## Résonances\n\n2026-10-07 — de [[autre-fiche|Autre]] :\n\nUne résonance.");
    expect(fs.existsSync(path.join(root(MEMBER.username), `books/fr/${SLUG}-fiche/_fragments/001.frag`))).toBe(true);
  });
});

describe("deleting a note", () => {
  test("the owner takes off a note another member signed", async () => {
    const aline = await find(MEMBER, "Une note d'Aline");
    expect((await call(MEMBER, "DELETE", `${ENTRY}/notes/${aline.id}`)).status).toBe(204);
    expect(fiche()).not.toContain("Une note d'Aline");
  });

  test("one of two twins goes, the other stays, and no blank lines pile up", async () => {
    const twins = (await notesOf(MEMBER)).filter((n: any) => n.text === "Deux fois la même.");
    expect(twins.length).toBe(2);
    expect((await call(MEMBER, "DELETE", `${ENTRY}/notes/${twins[0].id}`)).status).toBe(204);
    const left = (await notesOf(MEMBER)).filter((n: any) => n.text === "Deux fois la même.");
    expect(left.length).toBe(1);
    expect(left[0].id.endsWith("-0")).toBe(true);
    expect(fiche()).not.toMatch(/\n\n\n/);
  });

  test("the last note takes its heading with it; the rest of the fiche stays", async () => {
    const file = path.join(root(MEMBER.username), "books/fr/seul-edit-fiche.md");
    fs.writeFileSync(file,
      `---\ntitle: Seul\nresource_collection: books\nresource_id: seul-edit\ndate: '2026-09-01'\ntags: []\nlocale: fr\nopened: true\n---\n\nUne prose.\n\n## Commentaire\n\n2026-10-01 — La seule.\n`);
    const [note] = (await json(await call(MEMBER, "GET", "/entries/books/fr/seul-edit"))).mine.items
      .filter((i: any) => i.kind === "note");
    expect((await call(MEMBER, "DELETE", `/entries/books/fr/seul-edit/notes/${note.id}`)).status).toBe(204);
    const after = fs.readFileSync(file, "utf-8");
    expect(after.endsWith("---\n\nUne prose.\n")).toBe(true);
  });
});
