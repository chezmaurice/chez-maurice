// Talking a book over from Carnet's reader (16 November 2026): a conversation
// held from a book's fiche reads the member's highlights with it, and one can
// be opened from the reader itself — on the chapter open there, or on a
// passage just highlighted, which then leads to it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "maurice-reader-convo-"));
process.env.MAURICE_GARDENS_DIR = path.join(TMP, "gardens");

const LIBRARY = path.join(TMP, "metadata.db");
{
  const cal = new Database(LIBRARY);
  cal.exec(`
    CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, sort TEXT, path TEXT, uuid TEXT, timestamp TEXT);
    CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE books_authors_link (book INTEGER, author INTEGER);
    CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE books_tags_link (book INTEGER, tag INTEGER);
    CREATE TABLE series (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE books_series_link (book INTEGER, series INTEGER);
    CREATE TABLE comments (book INTEGER, text TEXT);
    CREATE TABLE data (book INTEGER, format TEXT, name TEXT);
    INSERT INTO books VALUES (7, 'Humus', 'Humus', 'Gaspard Koenig/Humus (7)', 'u-7', NULL);
    INSERT INTO books VALUES (8, 'Dune', 'Dune', 'Frank Herbert/Dune (8)', 'u-8', NULL);
    INSERT INTO authors VALUES (1, 'Gaspard Kœnig'), (2, 'Frank Herbert');
    INSERT INTO books_authors_link VALUES (7, 1), (8, 2);
  `);
  cal.close();
}
const previousLibrary = process.env.CALIBRE_DB_PATH;
process.env.CALIBRE_DB_PATH = LIBRARY;

const { default: db } = await import("../src/db");
const { createSession } = await import("../src/services/auth");
const { getConversation } = await import("../src/services/conversations");
const { getSpec } = await import("../src/services/composer/specs");
const { ficheText } = await import("../src/services/composer/fiches");
const conversations = (await import("../src/routes/conversations")).default;
const hl = await import("../data-api/services/highlights");
const ahl = await import("../data-api/services/articleHighlights");
const { resolveSpecToText } = await import("../src/services/composer/specs");

const ANNA = "rc-anna";
const BEN = "rc-ben";
const root = path.join(TMP, "gardens", ANNA);
let auth = "";

afterAll(() => {
  if (previousLibrary === undefined) delete process.env.CALIBRE_DB_PATH;
  else process.env.CALIBRE_DB_PATH = previousLibrary;
  fs.rmSync(TMP, { recursive: true, force: true });
});

function write(rel: string, content: string) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

const open = (body: unknown) =>
  conversations.request("/", { method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" }, body: JSON.stringify(body) });

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  for (const id of [ANNA, BEN]) {
    db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, 'standard')`, [id, id, id]);
  }
  db.run(`INSERT INTO user_preferences (user_id, locale) VALUES (?, 'fr') ON CONFLICT(user_id) DO UPDATE SET locale = 'fr'`, [ANNA]);
  auth = `Bearer ${createSession(ANNA).token}`;
  write(
    "books/fr/humus-roman-fiche.md",
    `---\ntitle: Humus, roman\nresource_collection: books\nresource_id: humus-roman\ndate: '2026-08-23'\ntags: []\nlocale: fr\nmeta:\n  calibre_id: 7\n---\n\n## Commentaire\n\nLu à l'été.\n`,
  );
});

describe("a conversation opened from the article reader", () => {
  test("on a passage: held from the article's entry, the passage in focus, and the passage leads to it", async () => {
    write(
      "articles/fr/sols-vivants-fiche.md",
      `---\ntitle: Sols vivants\nresource_collection: articles\ndate: '2026-11-08'\nlocale: fr\n---\n\n## Commentaire\n\nÀ relire.\n`,
    );
    const h = ahl.createArticleHighlight(ANNA, "fr", "sols-vivants", { quote: "Un sol vivant respire.", note: "comme Humus" });
    const res = await open({ entry: "articles/fr/sols-vivants", article_highlight: h.id });
    expect(res.status).toBe(201);
    const { id } = await res.json();
    expect(getConversation(id, ANNA)?.entry_ref).toBe("articles/fr/sols-vivants");
    const spec = getSpec(ANNA, id);
    expect(spec.items[0]!.focus).toEqual({ article_highlight: h.id });
    expect(ahl.getArticleHighlight(ANNA, h.id)?.conversation_id).toBe(id);
    const text = resolveSpecToText(ANNA, spec).items.map((r) => r.text).join("\n");
    expect(text).toContain("# Where this conversation starts");
    expect(text).toContain("> Un sol vivant respire.");
    expect(text).toContain("Their note on it: comme Humus");
    expect(ficheText(ANNA, "articles/fr/sols-vivants-fiche", false)).toContain(`(Talked over with Maurice in conversation ${id}.)`);

    // A second passage gets a conversation of its own.
    const h2 = ahl.createArticleHighlight(ANNA, "fr", "sols-vivants", { quote: "Il se tait." });
    const again = await (await open({ entry: "articles/fr/sols-vivants", article_highlight: h2.id })).json();
    expect(again.id).not.toBe(id);
  });

  test("only the member's own highlight, on that article", async () => {
    const ben = ahl.createArticleHighlight(BEN, "fr", "sols-vivants", { quote: "À Ben." });
    expect((await open({ entry: "articles/fr/sols-vivants", article_highlight: ben.id })).status).toBe(404);
    const elsewhere = ahl.createArticleHighlight(ANNA, "fr", "autre-article", { quote: "Ailleurs." });
    expect((await open({ entry: "articles/fr/sols-vivants", article_highlight: elsewhere.id })).status).toBe(404);
  });
});

describe("a book's fiche, as a conversation reads it", () => {
  test("carries the member's highlights, in reading order, with their notes", () => {
    hl.createHighlight(ANNA, 7, { chapterSlug: "0003-Le-ver", quote: "Le ver de terre laboure.", note: "Darwin déjà" });
    hl.createHighlight(ANNA, 7, { chapterSlug: "0002-Kevin", quote: "Kevin descend à Paris." });
    hl.createHighlight(BEN, 7, { chapterSlug: "0002-Kevin", quote: "Ce que Ben a souligné." });

    const text = ficheText(ANNA, "books/fr/humus-roman-fiche", false);
    expect(text).toContain("Lu à l'été.");
    expect(text).toContain("## Highlights");
    expect(text).toContain("Note: Darwin déjà");
    expect(text).not.toContain("Ben a souligné");
    expect(text.indexOf("Kevin descend")).toBeLessThan(text.indexOf("Le ver de terre"));
    expect(text).toContain("### Le-ver");
  });
});

describe("a conversation opened from the reader", () => {
  test("on a passage: held from the book's entry, the passage in focus, and the passage leads to it", async () => {
    const h = hl.createHighlight(ANNA, 7, { chapterSlug: "0004-Fin", quote: "La terre respire." });
    const res = await open({ book: 7, highlight: h.id });
    expect(res.status).toBe(201);
    const { id } = await res.json();
    expect(getConversation(id, ANNA)?.entry_ref).toBe("books/fr/humus-roman");
    const items = getSpec(ANNA, id).items;
    expect(items.map((i) => i.type)).toEqual(["fiche", "book"]);
    expect(items[1]!.focus).toEqual({ highlight: h.id });
    expect(hl.getHighlight(ANNA, h.id)?.conversation_id).toBe(id);
    expect(ficheText(ANNA, "books/fr/humus-roman-fiche", false)).toContain(`(Talked over with Maurice in conversation ${id}.)`);

    // A second passage gets a conversation of its own, not the empty one.
    const h2 = hl.createHighlight(ANNA, 7, { chapterSlug: "0004-Fin", quote: "Elle se tait." });
    const again = await (await open({ book: 7, highlight: h2.id })).json();
    expect(again.id).not.toBe(id);
  });

  test("on a chapter: the chapter in focus", async () => {
    const res = await open({ book: 7, chapter: "0002-Kevin" });
    const { id } = await res.json();
    expect(getSpec(ANNA, id).items[1]!.focus).toEqual({ chapter: "0002-Kevin" });
  });

  test("a book without an entry gets one", async () => {
    const res = await open({ book: 8 });
    const { id } = await res.json();
    expect(getConversation(id, ANNA)?.entry_ref).toBe("books/fr/dune");
    expect(fs.existsSync(path.join(root, "books/fr/dune-fiche.md"))).toBe(true);
  });

  test("only the member's own highlight, on that book", async () => {
    const ben = hl.createHighlight(BEN, 7, { chapterSlug: "0002-Kevin", quote: "À Ben." });
    expect((await open({ book: 7, highlight: ben.id })).status).toBe(404);
    const other = hl.createHighlight(ANNA, 8, { chapterSlug: "0001-Arrakis", quote: "Le désert." });
    expect((await open({ book: 7, highlight: other.id })).status).toBe(404);
    expect((await open({ book: 999 })).status).toBe(404);
  });
});
