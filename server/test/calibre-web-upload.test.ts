/**
 * A book added through Calibre-Web (services/calibreWebUpload.ts), against a
 * stand-in that behaves like Calibre-Web 0.6.27 at the two doors used: the
 * index, which sets the session cookie and carries the CSRF token, and
 * /upload, which wants both back, the member in its trusted header, and the
 * file as `btn-upload`, and answers `{ location }`.
 */
import { afterAll, beforeEach, expect, test } from "bun:test";

const { addThroughCalibreWeb } = await import("../data-api/services/calibreWebUpload");

const TOKEN = "tok-123";
let seen: { member?: string | null; cookie?: string | null; csrf?: string | null; field?: string; name?: string } = {};
let answer: () => Response = () => Response.json({ location: "/calibre/admin/book/42" });
const provisioned: string[] = [];

const fake = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/") {
      return new Response(`<form><input type="hidden" name="csrf_token" value="${TOKEN}"></form>`, {
        headers: { "Content-Type": "text/html", "Set-Cookie": "session=abc; HttpOnly; Path=/" },
      });
    }
    if (req.method === "POST" && url.pathname === "/upload") {
      const form = await req.formData();
      const file = form.get("btn-upload");
      seen = {
        member: req.headers.get("X-Maurice-Member"),
        cookie: req.headers.get("Cookie"),
        csrf: String(form.get("csrf_token")),
        field: file instanceof File ? await file.text() : undefined,
        name: file instanceof File ? file.name : undefined,
      };
      if (seen.cookie !== "session=abc" || seen.csrf !== TOKEN) return new Response("CSRF", { status: 400 });
      return answer();
    }
    return new Response("no", { status: 404 });
  },
});
afterAll(() => fake.stop());
const base = `http://127.0.0.1:${fake.port}`;
const provision = (m: { username: string }) => { provisioned.push(m.username); };
const book = () => new File(["EPUB"], "Middlemarch.epub", { type: "application/epub+zip" });

beforeEach(() => {
  seen = {};
  provisioned.length = 0;
  answer = () => Response.json({ location: "/calibre/admin/book/42" });
});

test("the file goes up as the member, with the page's cookie and token, and the book's id comes back", async () => {
  const r = await addThroughCalibreWeb(book(), { username: "anna", isAdmin: false }, base, provision);
  expect(r).toEqual({ ok: true, bookId: 42 });
  expect(seen).toEqual({ member: "anna", cookie: "session=abc", csrf: TOKEN, field: "EPUB", name: "Middlemarch.epub" });
  expect(provisioned).toEqual(["anna"]);
});

test("a member who may not edit lands on the book's page, which names it too", async () => {
  answer = () => Response.json({ location: "/calibre/book/7" });
  expect(await addThroughCalibreWeb(book(), { username: "anna", isAdmin: false }, base, provision)).toEqual({ ok: true, bookId: 7 });
});

test("a file Calibre-Web refuses sends it back to the index: no book, said so", async () => {
  answer = () => Response.json({ location: "/calibre/" });
  const r = await addThroughCalibreWeb(book(), { username: "anna", isAdmin: false }, base, provision);
  expect(r).toMatchObject({ ok: false, status: 422 });
});

test("no upload right is a 403; a Calibre-Web that does not answer is a 503", async () => {
  answer = () => new Response("Forbidden", { status: 403 });
  expect(await addThroughCalibreWeb(book(), { username: "anna", isAdmin: false }, base, provision)).toMatchObject({ ok: false, status: 403 });
  expect(await addThroughCalibreWeb(book(), { username: "anna", isAdmin: false }, "http://127.0.0.1:1", provision)).toMatchObject({ ok: false, status: 503 });
  const broken = () => { throw new Error("no app.db"); };
  expect(await addThroughCalibreWeb(book(), { username: "anna", isAdmin: false }, base, broken)).toMatchObject({ ok: false, status: 503 });
});

test("the same file again is the book it already is; another file of the same size is not", async () => {
  const { findSameFile } = await import("../data-api/services/calibreWebUpload");
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Database } = await import("bun:sqlite");
  const root = mkdtempSync(join(tmpdir(), "cw-dup-"));
  try {
    const db = new Database(join(root, "metadata.db"));
    db.run("CREATE TABLE books (id INTEGER PRIMARY KEY, path TEXT)");
    db.run("CREATE TABLE data (id INTEGER PRIMARY KEY, book INTEGER, format TEXT, uncompressed_size INTEGER, name TEXT)");
    db.run("INSERT INTO books VALUES (5, 'George Eliot/Middlemarch (5)')");
    db.run("INSERT INTO data VALUES (1, 5, 'EPUB', 4, 'Middlemarch')");
    db.close();
    mkdirSync(join(root, "George Eliot/Middlemarch (5)"), { recursive: true });
    writeFileSync(join(root, "George Eliot/Middlemarch (5)/Middlemarch.epub"), "EPUB");

    expect(await findSameFile(book(), root)).toBe(5);
    expect(await findSameFile(new File(["EPUX"], "Middlemarch.epub"), root)).toBeNull();
    expect(await findSameFile(new File(["EPUB"], "Middlemarch.pdf"), root)).toBeNull();
    expect(await findSameFile(book(), join(root, "nowhere"))).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
