// A book's fiche and the library's book (8 November 2026): a conversation
// that names a book of the household's library offers it as such — or as the
// fiche already tied to it — never as a stranger from the catalogue; and a
// reading companion's book gets its fiche, and is never offered from there.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "maurice-book-fiches-"));
process.env.MAURICE_GARDENS_DIR = path.join(TMP, "gardens");

// The household library, as Calibre keeps it: what the reads need, no more.
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
    INSERT INTO books VALUES (105, 'The Gene', 'Gene, The', 'Siddhartha Mukherjee/The Gene (105)', 'u-105', NULL);
    INSERT INTO books VALUES (97, 'The Selfish Gene', 'Selfish Gene, The', 'Richard Dawkins/The Selfish Gene (97)', 'u-97', NULL);
    INSERT INTO books VALUES (7, 'Humus', 'Humus', 'Gaspard Koenig/Humus (7)', 'u-7', NULL);
    INSERT INTO books VALUES (8, 'Dune', 'Dune', 'Frank Herbert/Dune (8)', 'u-8', NULL);
    INSERT INTO books VALUES (9, 'Dune', 'Dune', 'Someone Else/Dune (9)', 'u-9', NULL);
    INSERT INTO authors VALUES (1, 'Siddhartha Mukherjee'), (2, 'Richard Dawkins'), (3, 'Gaspard Kœnig'), (4, 'Frank Herbert'), (5, 'Someone Else');
    INSERT INTO books_authors_link VALUES (105, 1), (97, 2), (7, 3), (8, 4), (9, 5);
  `);
  cal.close();
}
const previousLibrary = process.env.CALIBRE_DB_PATH;
process.env.CALIBRE_DB_PATH = LIBRARY;

const { default: db } = await import("../src/db");
const sug = await import("../src/services/entrySuggestions");
const { createConversation, getConversation } = await import("../src/services/conversations");
const { loadLibrary, matchBook } = await import("../data-api/services/gardenShelf");
const { bookKey } = await import("../data-api/services/bookTitles");
const { listGardenEntries } = await import("../data-api/services/gardenEntries");
const { gardenFor, parseFiche } = await import("../data-api/services/gardenFiche");
const { linkBook } = await import("../data-api/services/gardenWrite");

const ANNA = "bf-anna";
const root = path.join(TMP, "gardens", ANNA);

afterAll(() => {
  // `bun test` runs every file in one process: the next one must not read this library.
  if (previousLibrary === undefined) delete process.env.CALIBRE_DB_PATH;
  else process.env.CALIBRE_DB_PATH = previousLibrary;
  fs.rmSync(TMP, { recursive: true, force: true });
});

function write(rel: string, content: string) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

let modelSays: unknown = { subjects: [] };
let toolCalls: Array<{ tool: string; args: any }> = [];

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, 'Anna', 'standard')`, [ANNA, ANNA]);
  db.run(`INSERT INTO user_preferences (user_id, locale) VALUES (?, 'fr') ON CONFLICT(user_id) DO UPDATE SET locale = 'fr'`, [ANNA]);
  // Humus has a fiche, under a title of its own, tied to the book by its id.
  write(
    "books/fr/humus-roman-fiche.md",
    `---\ntitle: Humus, roman\nresource_collection: books\nresource_id: humus-roman\ndate: '2026-08-23'\ntags: []\nlocale: fr\nmeta:\n  calibre_id: 7\n---\n`,
  );
  // A person whose card names them, with a fiche written under its slug.
  write("people/fr/michael-levin.md", `---\nname: "Michael Levin"\nrole: "Biologiste"\nlocale: "fr"\n---\n`);
  write(
    "people/fr/michael-levin-fiche.md",
    `---\ntitle: michael-levin\nresource_collection: people\nresource_id: michael-levin\ndate: '2026-10-16'\ntags: []\nlocale: fr\n---\n`,
  );

  sug.setSuggestionModel(async () =>
    ({ text: JSON.stringify(modelSays), model: "test", provider: "test", stop: "end", usage: null }) as any);
  sug.setGardenCall(async (_member, tool, args) => {
    toolCalls.push({ tool, args });
    return { card: "candidates", results: [] };
  });
});

let convo = "";
beforeEach(() => {
  db.run(`DELETE FROM entry_suggestions`);
  convo = createConversation(ANNA).id;
  modelSays = { subjects: [] };
  toolCalls = [];
});

const turn = () => sug.suggestForTurn(ANNA, convo, "m1", "Tu vois où j'en suis ?", "Au chapitre 3.");
const said = (title: string, creator?: string) => ({ kind: "books", title, creator, note: `On a parlé de ${title}.` });

describe("naming a book", () => {
  test("a subtitle, an article, accents and case aside", () => {
    expect(bookKey("The Gene: An Intimate History")).toBe(bookKey("The Gene"));
    expect(bookKey("Le Gène — une histoire intime")).toBe(bookKey("gène"));
    expect(bookKey("The Selfish Gene")).not.toBe(bookKey("The Gene"));
    expect(bookKey("La Propension des choses. Pour une histoire de l'efficacité en Chine")).toBe(bookKey("La propension des choses"));
    expect(bookKey("Being You : A New Science of Consciousness (9780571337736)")).toBe(bookKey("Being You"));
  });

  test("one book answers, or the doubt says which", () => {
    const lib = loadLibrary();
    expect(matchBook(lib, "The Gene: An Intimate History", "Mukherjee").book?.id).toBe(105);
    expect(matchBook(lib, "The Gene", null).book?.id).toBe(105);
    // Another author under the same title: not this book.
    expect(matchBook(lib, "The Gene", "Dawkins").book).toBeNull();
    // Kœnig is Koenig.
    expect(matchBook(lib, "Humus", "Gaspard Koenig").book?.id).toBe(7);
    // Two books under one title: the author decides, or nobody does.
    expect(matchBook(lib, "Dune", "Herbert").book?.id).toBe(8);
    const dune = matchBook(lib, "Dune", null);
    expect(dune.book).toBeNull();
    expect(dune.doubtful.map((b) => b.id).sort()).toEqual([8, 9]);
  });
});

describe("a conversation names a book of the library", () => {
  test("with no fiche: offered as the library's, without asking any catalogue", async () => {
    modelSays = { subjects: [said("The Gene: An Intimate History", "Siddhartha Mukherjee")] };
    expect(await turn()).toBe(1);
    const [row] = sug.suggestionsFor(ANNA, convo);
    expect(row).toMatchObject({ key: "calibre:105", title: "The Gene", existing: null, in_library: true });
    expect(toolCalls).toEqual([]);
  });

  test("kept: the fiche is tied to the book", async () => {
    modelSays = { subjects: [said("The Gene", "Mukherjee")] };
    await turn();
    const [row] = sug.suggestionsFor(ANNA, convo);
    const kept = await sug.keepSuggestion(ANNA, row!.id);
    expect(kept.state).toBe("kept");
    expect(kept.kept_path).toBe("books/fr/the-gene");
    const fiche = parseFiche(fs.readFileSync(path.join(root, "books/fr/the-gene-fiche.md"), "utf-8"))!;
    expect(fiche.frontmatter.meta.calibre_id).toBe(105);
    expect(fiche.body).toContain("On a parlé de The Gene.");
    expect(toolCalls.some((c) => c.tool === "open_fiche")).toBe(false);
    fs.rmSync(path.join(root, "books/fr/the-gene-fiche.md"));
  });

  test("with a fiche tied to it under another title: that fiche", async () => {
    modelSays = { subjects: [said("Humus", "Gaspard Koenig")] };
    await turn();
    const [row] = sug.suggestionsFor(ANNA, convo);
    expect(row).toMatchObject({ existing: "books/fr/humus-roman", in_library: false });
  });
});

describe("a reading companion", () => {
  test("its book gets its fiche, holds the conversation, and is never offered", async () => {
    const companion = crypto.randomUUID();
    db.run(
      `INSERT INTO maurices (id, name, kind, context_json, created_by) VALUES (?, 'The Gene', 'companion', ?, ?)`,
      [companion, JSON.stringify({ items: [{ type: "book", id: 105, representation: "summary", scope: { mode: "progress" } }] }), ANNA],
    );
    db.run(`UPDATE conversations SET maurice_id = ? WHERE id = ?`, [companion, convo]);
    modelSays = { subjects: [said("The Gene: An Intimate History", "Mukherjee"), said("The Selfish Gene", "Dawkins")] };
    await turn();
    expect(getConversation(convo, ANNA)?.entry_ref).toBe("books/fr/the-gene");
    const fiche = parseFiche(fs.readFileSync(path.join(root, "books/fr/the-gene-fiche.md"), "utf-8"))!;
    expect(fiche.frontmatter.meta.calibre_id).toBe(105);
    // The companion's book is what the conversation is about: only the other one is offered.
    expect(sug.suggestionsFor(ANNA, convo).map((r) => r.title)).toEqual(["The Selfish Gene"]);
  });
});

test("a person's card names them: the entry has their name, not its slug", () => {
  const levin = listGardenEntries(gardenFor(ANNA)!).find((e) => e.slug === "michael-levin");
  expect(levin?.title).toBe("Michael Levin");
});

describe("tying an entry to a book by hand", () => {
  const ref = { collection: "books", locale: "fr", slug: "dune-le-roman" };

  beforeAll(() => {
    // A title two books of the library answer to: nothing ties it by itself.
    write("books/fr/dune-le-roman-fiche.md",
      `---\ntitle: Dune\nresource_collection: books\nresource_id: dune-le-roman\ndate: '2026-08-01'\ntags: []\nlocale: fr\nmeta:\n  title: Dune\n---\n\nLu en août.\n`);
  });

  test("the book the member names becomes the entry's source", async () => {
    const garden = gardenFor(ANNA)!;
    await linkBook(ANNA, garden, ref, 9);
    const fiche = parseFiche(fs.readFileSync(path.join(root, "books/fr/dune-le-roman-fiche.md"), "utf-8"))!;
    expect(fiche.frontmatter.meta.calibre_id).toBe(9);
    expect(fiche.body).toContain("Lu en août.");
    // Named again, to the other edition: the member's word replaces the first.
    await linkBook(ANNA, garden, ref, 8);
    expect(parseFiche(fs.readFileSync(path.join(root, "books/fr/dune-le-roman-fiche.md"), "utf-8"))!.frontmatter.meta.calibre_id).toBe(8);
  });

  test("a book already another entry's stays with it", async () => {
    // Humus is the book of humus-roman.
    await expect(linkBook(ANNA, gardenFor(ANNA)!, ref, 7)).rejects.toMatchObject({ status: 409 });
  });

  test("only a book, and only one the library has", async () => {
    await expect(linkBook(ANNA, gardenFor(ANNA)!, { collection: "people", locale: "fr", slug: "michael-levin" }, 8))
      .rejects.toThrow();
    await expect(linkBook(ANNA, gardenFor(ANNA)!, ref, 4242)).rejects.toMatchObject({ status: 404 });
  });
});

test("PUT …/book answers the entry with the book as its source", async () => {
  const { Hono } = await import("hono");
  const { default: entries } = await import("../data-api/routes/garden-entries");
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("userId" as never, ANNA as never); await next(); });
  app.route("/", entries);
  const put = (slug: string, body: unknown) => app.request(`/entries/books/fr/${slug}/book`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const res = await put("dune-le-roman", { book_id: 9 });
  expect(res.status).toBe(201);
  const entry = await res.json() as any;
  expect(entry.source).toMatchObject({ type: "book", book_id: 9 });
  expect((await put("dune-le-roman", {})).status).toBe(400);
  expect((await put("dune-le-roman", { book_id: 7 })).status).toBe(409);
});
