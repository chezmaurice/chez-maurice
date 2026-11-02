/**
 * Sharing an article gives it: the member it is shared with gets a fiche of
 * their own — text, styles, cover, summaries — that lives apart from the
 * owner's from then on. Run with `bun test`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Hono } from "hono";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "maurice-shared-articles-"));
const GARDENS = path.join(TMP, "gardens");
process.env.MAURICE_GARDENS_DIR = GARDENS;

const { default: entries } = await import("../data-api/routes/garden-entries");
const { copyArticleTo, findArticleFiche, listArticles, readArticleBody, saveArticleFiche, scanArticleFiches } =
  await import("../data-api/services/gardenArticles");
const { readFullText, whenSummariesSettled } = await import("../data-api/services/articleSummary");
const { listShelf } = await import("../data-api/services/gardenShelf");
const { gardenFor, parseFiche, writeFiche } = await import("../data-api/services/gardenFiche");
const { MEMBER } = await import("./_member");
const { userLocale } = await import("../src/services/i18n");
const { default: db } = await import("../src/db");

const READER = { id: "shared-article-paola", username: "paola-article" };

const app = new Hono();
app.use("*", async (c, next) => {
  (c as any).set("userId", c.req.header("x-user"));
  await next();
});
app.route("/", entries);
const call = (who: { id: string }, method: string, url: string, body?: unknown) =>
  app.request(url, {
    method,
    headers: { "x-user": who.id, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const page = `<!doctype html><html lang="fr"><head>
<title>Un article payant | Le Monde</title>
<meta property="og:title" content="Un article payant partagé">
<meta property="og:site_name" content="Le Monde">
</head><body><article><p>${"Le texte que seul l'abonné a capturé. ".repeat(60)}</p></article></body></html>`;

const owner = { id: MEMBER.id, username: MEMBER.username };
const theirs = () => gardenFor(READER.id)!;
let saved: any;

beforeAll(async () => {
  process.env.MAURICE_GARDENS_DIR = GARDENS;
  db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, 'standard')`,
    [READER.id, READER.username, "Paola"]);
  for (const username of [MEMBER.username, READER.username]) {
    const root = path.join(GARDENS, username);
    fs.mkdirSync(root, { recursive: true });
    for (const args of [["init", "-q"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) {
      spawnSync("git", args, { cwd: root });
    }
  }
  saved = await saveArticleFiche(MEMBER.id, {
    url: "https://www.lemonde.fr/a/payant-partage.html", html: page, comment: "Ma note à moi.",
  });
  // A summary already written, current: the copy carries it, and no model is called.
  const parsed = parseFiche(fs.readFileSync(saved.file, "utf-8"))!;
  const meta = { ...(parsed.frontmatter.meta as any), summary: "Le résumé.", summary_long: "Le long.", summary_lang: "fr", summary_version: 4 };
  writeFiche(saved.file, { ...parsed.frontmatter, meta } as any, parsed.body);
});

afterAll(() => {
  db.run(`DELETE FROM entry_shares WHERE owner_id = ?`, [MEMBER.id]);
  db.run(`DELETE FROM users WHERE id = ?`, [READER.id]);
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("sharing an article gives a copy", () => {
  test("the copy is the reader's own: text, summaries, who gave it — not the owner's notes", () => {
    const ref = scanArticleFiches(gardenFor(MEMBER.id)!).find((r) => r.slug === saved.slug)!;
    expect(copyArticleTo(owner, ref, READER.id)).toBe("copied");

    const copy = findArticleFiche(theirs(), saved.url)!;
    expect(copy).toBeTruthy();
    expect(copy.file.startsWith(theirs().root)).toBe(true);
    expect(readFullText(copy.file)).toContain("seul l'abonné a capturé");
    const listed = listArticles(theirs()).find((a) => a.slug === copy.slug)!;
    expect(listed.summary).toBe("Le résumé.");
    expect(listed.summary_long).toBe("Le long.");
    expect(listed.opened).toBe(false);
    expect((listed.shared_by as any).username).toBe(MEMBER.username);
    expect(readArticleBody(copy)).not.toContain("Ma note à moi.");
  });

  test("sharing again never makes a second copy", () => {
    const ref = scanArticleFiches(gardenFor(MEMBER.id)!).find((r) => r.slug === saved.slug)!;
    expect(copyArticleTo(owner, ref, READER.id)).toBe("exists");
    expect(listArticles(theirs()).filter((a) => a.url === saved.url)).toHaveLength(1);
  });

  test("the copy lives apart: deleting the owner's leaves the reader's", async () => {
    db.run(`INSERT OR IGNORE INTO entry_shares (owner_id, collection, locale, slug, member_id) VALUES (?, 'articles', ?, ?, ?)`,
      [MEMBER.id, saved.locale, saved.slug, READER.id]);
    // Listed once, as the reader's own copy — not again as the owner's fiche.
    const { entries: rows } = await listShelf(READER.id, theirs());
    const mine = rows.filter((r: any) => r.collection === "articles" && r.source?.url === saved.url);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.owner).toBeFalsy();
    expect((mine[0]!.source as any).shared_by.username).toBe(MEMBER.username);
    expect((mine[0]!.source as any).captured).toBe(true);

    const del = await call(owner, "DELETE", `/entries/articles/${saved.locale}/${saved.slug}`);
    expect(del.status).toBeLessThan(300);
    expect(findArticleFiche(theirs(), saved.url)).toBeTruthy();
  });

  test("the share route gives the copy, after the summary pass", async () => {
    const other = await saveArticleFiche(MEMBER.id, { url: "https://www.lemonde.fr/a/second-partage.html", html: page.replace("payant partagé", "second") });
    // Its summary current in the owner's language: the pass finds nothing to do.
    const parsed = parseFiche(fs.readFileSync(other.file, "utf-8"))!;
    const meta = { ...(parsed.frontmatter.meta as any), summary: "Court.", summary_long: "Long.", summary_lang: userLocale(MEMBER.id), summary_version: 4 };
    writeFiche(other.file, { ...parsed.frontmatter, meta } as any, parsed.body);

    const r = await call(owner, "POST", `/entries/articles/${other.locale}/${other.slug}/participants`, { username: READER.username });
    expect(r.status).toBe(201);
    await whenSummariesSettled();
    const copy = listArticles(theirs()).find((x) => x.url === other.url);
    expect(copy?.summary).toBe("Court.");
  });
});
