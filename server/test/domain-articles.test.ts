/**
 * Saved articles filed under the member's domains (services/domainArticles.ts).
 * The light model is a stub; the fiches are real files in a throwaway garden.
 * What is nailed down: a member without domains costs nothing; the model's
 * number files the article once, and an answer of 0 or off the list leaves it
 * unfiled; the member's choice prevails and `none` is never filed again; a
 * domain not theirs is refused; the brief reads what was filed, with the
 * member's note (8 November 2026).
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { default: db } = await import("../src/db");
const { addModel } = await import("../src/services/models");
const { setPinnedModel } = await import("../src/services/ancillary");
const filing = await import("../src/services/domainArticles");
const briefs = await import("../src/services/domainBriefs");
const { createMaurice } = await import("../src/services/maurices");

const READER = "articles-reader";
const OTHER = "articles-other";
const LIGHT = "qwen3.6-35b-a3b";
const GARDENS = mkdtempSync(join(tmpdir(), "maurice-domain-articles-"));
const savedGardens = process.env.MAURICE_GARDENS_DIR;
const FICHE = "notes/fr/articles/sommeil-profond.md";

type Req = { system?: string; prompt: string; invocation: string };
let requests: Req[] = [];
let answer = '{"domain": 1}';

function reply(text: string) {
  return {
    text,
    model: LIGHT,
    provider: "scaleway",
    stop: "end" as const,
    usage: { provider: "scaleway", model: LIGHT, rounds: 1, input: 300, output: 5, cache_read: 0, cache_write: 0, cost: 0.00001, cost_uncached: 0.00001 },
  };
}

async function light(req: Req) {
  requests.push(req);
  return reply(answer);
}

async function night(req: Req) {
  requests.push(req);
  if ((req.system ?? "").includes("one-line index entry")) return reply("La santé.");
  return reply("Le brief de la santé.");
}

function fiche(member: string) {
  const file = join(GARDENS, member, FICHE);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(
    file,
    `---\ntitle: "Le sommeil profond"\nresource_collection: articles\ndate: "2026-11-08"\nlocale: fr\nmeta:\n  publication: Le Monde\n  saved_at: "2026-11-08T20:00:00Z"\n  summary: "Ce que fait le cerveau pendant le sommeil profond."\n---\n\n> Le sommeil profond nettoie le cerveau.\n\n## Commentaire\n\nÀ relire avant de changer mes horaires.\n`,
  );
}

const ARTICLE = { title: "Le sommeil profond", publication: "Le Monde", url: "https://www.lemonde.fr/sommeil", excerpt: "Le cerveau la nuit.", comment: "Pour mes horaires" };
let sante: { id: string };
let jardin: { id: string };

beforeAll(() => {
  process.env.MAURICE_GARDENS_DIR = GARDENS;
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  db.run(`UPDATE households SET scaleway_api_key = 'test-key' WHERE id = 'default'`);
  for (const id of [READER, OTHER]) {
    db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, 'standard')`, [id, id, id]);
  }
  if (!db.query(`SELECT 1 FROM models WHERE id = ?`).get(LIGHT)) {
    addModel({ id: LIGHT, name: "Qwen", tier: "cloud", vendor: "qwen", provider: "scaleway" });
  }
  setPinnedModel("article_domain", LIGHT);
  setPinnedModel("domain_brief", LIGHT);
  filing.setFilingModel(light as any);
  briefs.setBriefDeps({ write: night as any, search: async () => [] });
});

afterAll(() => {
  filing.setFilingModel(null);
  briefs.setBriefDeps(null);
  // The members go too: the dictation's vocabulary reads every member's name,
  // and two more crowd others out of its 400 characters.
  for (const m of [READER, OTHER]) {
    db.run(`DELETE FROM domain_articles WHERE member_id = ?`, [m]);
    db.run(`DELETE FROM domain_briefs WHERE member_id = ?`, [m]);
    db.run(`DELETE FROM maurices WHERE created_by = ?`, [m]);
    db.run(`DELETE FROM users WHERE id = ?`, [m]);
  }
  if (savedGardens === undefined) delete process.env.MAURICE_GARDENS_DIR;
  else process.env.MAURICE_GARDENS_DIR = savedGardens;
  rmSync(GARDENS, { recursive: true, force: true });
});

beforeEach(() => {
  requests = [];
  answer = '{"domain": 1}';
  for (const m of [READER, OTHER]) {
    db.run(`DELETE FROM domain_articles WHERE member_id = ?`, [m]);
    db.run(`DELETE FROM domain_briefs WHERE member_id = ?`, [m]);
    db.run(`DELETE FROM maurices WHERE created_by = ?`, [m]);
  }
  // Sorted by name in the choice: « Jardin » is 1, « Santé » is 2.
  sante = createMaurice(READER, { name: "Santé", kind: "domain", tagline: "Le corps, le sommeil", prompt: "", context: [], users: [READER] });
  jardin = createMaurice(READER, { name: "Jardin", kind: "domain", tagline: "", prompt: "", context: [], users: [READER] });
  fiche(READER);
});

test("a member without domains costs nothing", async () => {
  const filed = await filing.fileArticle(OTHER, FICHE, ARTICLE);
  expect(filed).toEqual({ domain: null, by: null });
  expect(requests).toHaveLength(0);
});

test("the model's number files the article, once", async () => {
  answer = '{"domain": 2}';
  const filed = await filing.fileArticle(READER, FICHE, ARTICLE);
  expect(filed.domain?.id).toBe(sante.id);
  expect(filed.by).toBe("auto");
  const prompt = requests[0]!.prompt;
  expect(prompt).toContain("1. Jardin");
  expect(prompt).toContain("2. Santé — Le corps, le sommeil");
  expect(prompt).toContain('"Le sommeil profond" (Le Monde, lemonde.fr)');
  expect(prompt).toContain("THEIR NOTE: Pour mes horaires");
  // Already filed: not asked again.
  await filing.fileArticle(READER, FICHE, ARTICLE);
  expect(requests).toHaveLength(1);
});

test("none, or an answer off the list, leaves it unfiled", async () => {
  for (const text of ['{"domain": 0}', '{"domain": 7}', "Je ne sais pas"]) {
    answer = text;
    expect((await filing.fileArticle(READER, FICHE, ARTICLE)).domain).toBeNull();
  }
  expect(filing.articleDomain(READER, FICHE).by).toBeNull();
  expect(filing.parseChoice("2", 3)).toBe(2);
});

test("the member's choice prevails, and none is never filed again", async () => {
  await filing.fileArticle(READER, FICHE, ARTICLE); // Jardin, by the model
  const moved = filing.setArticleDomain(READER, FICHE, sante.id);
  expect(moved).toEqual({ domain: { id: sante.id, name: "Santé", icon: null }, by: "member" });
  const out = filing.setArticleDomain(READER, FICHE, null);
  expect(out).toEqual({ domain: null, by: "none" });
  requests = [];
  expect((await filing.fileArticle(READER, FICHE, ARTICLE)).by).toBe("none");
  expect(requests).toHaveLength(0);
  expect(() => filing.setArticleDomain(OTHER, FICHE, sante.id)).toThrow();
});

test("the brief reads the articles filed under it, with the member's note", async () => {
  filing.setArticleDomain(READER, FICHE, sante.id);
  const excerpt = filing.articleExcerpt(READER, FICHE)!;
  expect(excerpt).toContain('— Article saved "Le sommeil profond" (Le Monde, 2026-11-08)');
  expect(excerpt).toContain("Ce que fait le cerveau pendant le sommeil profond.");
  expect(excerpt).toContain("Their note: À relire avant de changer mes horaires.");

  const domain = (await import("../src/services/maurices")).getMaurice(sante.id)!;
  const r = await briefs.refreshBrief(domain, READER);
  expect(r.outcome).toBe("written");
  const prompt = requests.find((q) => q.prompt.includes("Write the brief"))!.prompt;
  expect(prompt).toContain("articles they saved");
  expect(prompt).toContain('Article saved "Le sommeil profond"');
  expect(r.brief!.sources).toContain(`article:${FICHE}`);
});
