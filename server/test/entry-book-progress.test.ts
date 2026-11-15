// A conversation opened from a book's page in Carnet (issue #41, 15 November
// 2026): the member was reading it in Carnet, the position was recorded
// seconds before, and Maurice answered he had no idea where they were — the
// conversation held the fiche and nothing else. The book now comes too, on the
// `progress` scope, as soon as the member has started it; not before.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "maurice-entry-book-"));
process.env.MAURICE_GARDENS_DIR = path.join(TMP, "gardens");
// life.db (reading_progress) of its own: the service reopens on a new path,
// and an earlier file's may already be gone.
const previousDataDir = process.env.MAURICE_DATA_DIR;
process.env.MAURICE_DATA_DIR = TMP;

// The member's library: metadata.db, and one book's chapters and summaries
// beside it (no uuid, so the artifacts live under the book's own path).
const LIBRARY = path.join(TMP, "library");
const BOOK_DIR = path.join(LIBRARY, "Edward Kelly/Irreducible Mind (156)");
const CHAPTERS = ["0001-Chapter One", "0002-Chapter Two", "0003-Chapter Three"];
{
  fs.mkdirSync(path.join(BOOK_DIR, "chapters"), { recursive: true });
  fs.mkdirSync(path.join(BOOK_DIR, "chapter_summaries"), { recursive: true });
  CHAPTERS.forEach((ref, i) => {
    fs.writeFileSync(path.join(BOOK_DIR, "chapters", `${ref}.txt`), `Texte du chapitre ${i + 1}. `.repeat(4000));
    fs.writeFileSync(path.join(BOOK_DIR, "chapter_summaries", `${ref}.summary.txt`), `Résumé du chapitre ${i + 1}.`);
  });
  const cal = new Database(path.join(LIBRARY, "metadata.db"));
  cal.exec(`
    CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, sort TEXT, path TEXT, timestamp TEXT);
    CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE books_authors_link (book INTEGER, author INTEGER);
    INSERT INTO books VALUES (156, 'Irreducible Mind', 'Irreducible Mind', 'Edward Kelly/Irreducible Mind (156)', NULL);
    INSERT INTO authors VALUES (1, 'Edward Kelly');
    INSERT INTO books_authors_link VALUES (156, 1);
  `);
  cal.close();
}

const { default: db } = await import("../src/db");
const conversations = (await import("../src/routes/conversations")).default;
const { createSession } = await import("../src/services/auth");
const { getSpec, resolveToText } = await import("../src/services/composer/specs");
const { updateReadingProgress, clearReadingProgress } = await import("../data-api/services/bookmarks");

const ANNA = "ebp-anna";
const root = path.join(TMP, "gardens", ANNA);
let auth = "";

afterAll(() => {
  clearReadingProgress(ANNA, 156);
  if (previousDataDir === undefined) delete process.env.MAURICE_DATA_DIR;
  else process.env.MAURICE_DATA_DIR = previousDataDir;
  fs.rmSync(TMP, { recursive: true, force: true });
});

function write(rel: string, content: string) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

const fiche = (slug: string, meta: string) =>
  `---\ntitle: ${slug}\nresource_collection: books\nresource_id: ${slug}\ndate: '2026-11-12'\ntags: []\nlocale: fr\nmeta:\n${meta}---\n`;

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, 'Anna', 'standard')`, [ANNA, ANNA]);
  db.run(`INSERT OR IGNORE INTO calibre_libraries (id, account_id, library_root, is_default) VALUES ('ebp-lib', ?, ?, 1)`, [ANNA, LIBRARY]);
  auth = `Bearer ${createSession(ANNA).token}`;
  write("books/fr/irreducible-mind-fiche.md", fiche("irreducible-mind", "  calibre_id: 156\n"));
  write("books/fr/un-livre-sans-id-fiche.md", fiche("un-livre-sans-id", "  author: Personne\n"));
});

const post = async (entry: string) => {
  const res = await conversations.request("/", {
    method: "POST", body: JSON.stringify({ entry }),
    headers: { Authorization: auth, "Content-Type": "application/json" },
  });
  expect([200, 201]).toContain(res.status);
  return ((await res.json()) as any).id as string;
};
const items = (convo: string) => getSpec(ANNA, convo).items.map((i: any) => [i.type, String(i.id)]);

describe("opening a conversation from a book's page", () => {
  test("not started: the fiche alone", async () => {
    clearReadingProgress(ANNA, 156);
    const convo = await post("books/fr/irreducible-mind");
    expect(items(convo)).toEqual([["fiche", "books/fr/irreducible-mind-fiche"]]);
  });

  test("started in Carnet: the book comes too, on the progress scope, and stops where the reader stopped", async () => {
    updateReadingProgress(ANNA, 156, 1, "0002-Chapter Two", "summary");
    const convo = await post("books/fr/irreducible-mind");
    expect(items(convo)).toEqual([["fiche", "books/fr/irreducible-mind-fiche"], ["book", "156"]]);
    const book = getSpec(ANNA, convo).items[1] as any;
    expect(book.scope).toEqual({ mode: "progress" });
    expect(book.snapshot.tracksProgress).toBe(true);
    const text = resolveToText(ANNA, convo).items.map((i: any) => i.text).join("\n");
    expect(text).toContain("Résumé du chapitre 2.");
    expect(text).not.toContain("Résumé du chapitre 3.");
  });

  test("a fiche that names no library book: the fiche alone", async () => {
    const convo = await post("books/fr/un-livre-sans-id");
    expect(items(convo)).toEqual([["fiche", "books/fr/un-livre-sans-id-fiche"]]);
  });
});
