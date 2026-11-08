import fs from "node:fs";
import path from "node:path";
import db from "../db";
import { gardenFor, parseFiche } from "../../data-api/services/gardenFiche";
import { ancillaryComplete, type AncillaryRequest, type AncillaryResult } from "./ancillary";
import { recordSpend } from "./budget";
import { isDomain, listMaurices } from "./maurices";

// Saved articles filed under the member's domains (8 November 2026).
//
// The tags a share used to ask for are gone: a domain is a tag the member
// does not have to type. At the save, the light model reads the article — its
// title, where it is from, its opening, and the member's note when there is
// one — beside the member's adopted domains (name, tagline, the brief's
// one-liner), and names one of them or none. The share sheet says where it
// went and offers *Change*; the member's choice prevails and is never
// revisited, and an article they took out of every domain (`none`) is never
// filed again.
//
// Why the model and not the corpus's neighbours, which file conversations:
// no article is filed yet, so there is no neighbour to vote, and an article's
// prose against a member's questions sorts by style before subject — the
// same reason the mail's digests are grouped among themselves
// (services/domainMail.ts).
//
// What it is for: the domain's brief reads the articles filed under it since
// the last rewrite (services/domainBriefs.ts), so a domain knows what the
// member read about it, not only what they said.

export type FiledBy = "auto" | "member" | "none";

export interface ArticleDomain {
  domain: { id: string; name: string; icon: string | null } | null;
  by: FiledBy | null;
}

/** What the model sees of the article. */
export interface ArticleForFiling {
  title: string;
  publication?: string | null;
  url?: string | null;
  excerpt?: string | null;
  comment?: string | null;
}

/** The member's adopted domains, as the choice is offered: in the share
 *  sheet's *Change* and in the model's prompt. */
export function domainChoices(memberId: string): Array<{ id: string; name: string; icon: string | null; tagline: string | null }> {
  return listMaurices()
    .filter((m) => m.created_by === memberId && isDomain(m))
    .map((m) => ({ id: m.id, name: m.name, icon: m.icon ?? null, tagline: m.tagline?.trim() || null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Where an article is filed, if anywhere. */
export function articleDomain(memberId: string, ficheRel: string): ArticleDomain {
  const row = db
    .query(
      `SELECT a.by, m.id, m.name, m.icon FROM domain_articles a LEFT JOIN maurices m ON m.id = a.maurice_id
        WHERE a.member_id = ? AND a.path = ?`,
    )
    .get(memberId, ficheRel) as { by: FiledBy; id: string | null; name: string | null; icon: string | null } | null;
  if (!row) return { domain: null, by: null };
  return { domain: row.id ? { id: row.id, name: row.name!, icon: row.icon } : null, by: row.by };
}

/** The member's choice: a domain of theirs, or none (never filed again). */
export function setArticleDomain(memberId: string, ficheRel: string, domainId: string | null): ArticleDomain {
  if (domainId && !domainChoices(memberId).some((d) => d.id === domainId)) {
    throw new Error("not one of the member's domains");
  }
  db.run(
    `INSERT INTO domain_articles (member_id, path, maurice_id, by) VALUES (?, ?, ?, ?)
       ON CONFLICT (member_id, path) DO UPDATE SET maurice_id = excluded.maurice_id, by = excluded.by,
         added_at = CASE WHEN domain_articles.maurice_id IS excluded.maurice_id THEN domain_articles.added_at ELSE datetime('now') END`,
    [memberId, ficheRel, domainId, domainId ? "member" : "none"],
  );
  return articleDomain(memberId, ficheRel);
}

let completeWith: (req: AncillaryRequest) => Promise<AncillaryResult> = ancillaryComplete;
/** Tests replace the model. */
export function setFilingModel(fn: ((req: AncillaryRequest) => Promise<AncillaryResult>) | null): void {
  completeWith = fn ?? ancillaryComplete;
}

const SYSTEM = `You file a saved article under one of a person's domains — the parts of their life they follow — or under none.
Answer with JSON only: {"domain": N} where N is the number of the domain, or {"domain": 0} when none clearly fits.
Choose a domain only when the article is plainly about that part of their life; a loose connection is 0.
The person's note, when there is one, says why they kept it: weigh it most.`;

/** The number in the model's answer, or null when there is none to read. */
export function parseChoice(text: string, count: number): number | null {
  const m = text.match(/"domain"\s*:\s*(\d+)/) ?? text.trim().match(/^(\d+)$/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 0 && n <= count ? n : null;
}

/** The brief's one-liner, or its opening: what the domain is, in its own words. */
function briefLine(domainId: string, memberId: string): string | null {
  const row = db
    .query(`SELECT text, summary FROM domain_briefs WHERE maurice_id = ? AND member_id = ?`)
    .get(domainId, memberId) as { text: string; summary: string | null } | null;
  const line = (row?.summary?.trim() || row?.text.trim().split(/\n\s*\n/)[0] || "").replace(/\s+/g, " ");
  return line ? (line.length > 300 ? line.slice(0, 299) + "…" : line) : null;
}

export function filingPrompt(memberId: string, article: ArticleForFiling, domains: ReturnType<typeof domainChoices>): string {
  const list = domains
    .map((d, i) => {
      const line = briefLine(d.id, memberId);
      return `${i + 1}. ${d.name}${d.tagline ? ` — ${d.tagline}` : ""}${line ? `\n   ${line}` : ""}`;
    })
    .join("\n");
  let host = "";
  try {
    host = article.url ? new URL(article.url).hostname.replace(/^www\./, "") : "";
  } catch {}
  const from = [article.publication, host].filter(Boolean).join(", ");
  return [
    `THE DOMAINS:\n${list}`,
    `THE ARTICLE: "${article.title}"${from ? ` (${from})` : ""}` +
      (article.excerpt?.trim() ? `\n${article.excerpt.trim().slice(0, 800)}` : ""),
    article.comment?.trim() ? `THEIR NOTE: ${article.comment.trim().slice(0, 600)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * File a just-saved article, unless it is filed already or was taken out of
 * every domain. Returns where it is. A member with no domain costs nothing;
 * a model that fails or answers off the list leaves the article unfiled.
 */
export async function fileArticle(memberId: string, ficheRel: string, article: ArticleForFiling): Promise<ArticleDomain> {
  const current = articleDomain(memberId, ficheRel);
  if (current.by) return current;
  const domains = domainChoices(memberId);
  if (!domains.length) return current;

  const result = await completeWith({
    memberId,
    invocation: "article_domain",
    system: SYSTEM,
    prompt: filingPrompt(memberId, article, domains),
    maxTokens: 20,
    temperature: 0,
    reasoning: "none",
  });
  recordSpend(result.usage, memberId, null, "articles");
  const n = parseChoice(result.text, domains.length);
  if (!n) return current;
  // A member who chose while the model was answering keeps their choice.
  db.run(`INSERT OR IGNORE INTO domain_articles (member_id, path, maurice_id, by) VALUES (?, ?, ?, 'auto')`, [
    memberId,
    ficheRel,
    domains[n - 1]!.id,
  ]);
  return articleDomain(memberId, ficheRel);
}

// ── What a domain's brief reads ──────────────────────────────────────────────

/** A domain's articles, those filed after `after` when given (the brief reads
 *  each once), oldest first. */
export function domainArticles(domainId: string, memberId: string, after: string | null = null): Array<{ path: string; added_at: string }> {
  return (
    after
      ? db.query(`SELECT path, added_at FROM domain_articles WHERE maurice_id = ? AND member_id = ? AND added_at > ? ORDER BY added_at, path`).all(domainId, memberId, after)
      : db.query(`SELECT path, added_at FROM domain_articles WHERE maurice_id = ? AND member_id = ? ORDER BY added_at, path`).all(domainId, memberId)
  ) as Array<{ path: string; added_at: string }>;
}

/** What the brief carries of an article: its title and source, its summary
 *  (or opening), and the member's note. Null when the fiche is gone. */
export function articleExcerpt(memberId: string, rel: string, chars = 1000): string | null {
  const garden = gardenFor(memberId);
  if (!garden || rel.includes("..")) return null;
  let parsed: ReturnType<typeof parseFiche>;
  try {
    parsed = parseFiche(fs.readFileSync(path.join(garden.root, rel), "utf8"));
  } catch {
    return null;
  }
  if (!parsed) return null;
  const fm = parsed.frontmatter as Record<string, any>;
  const meta = (fm.meta ?? {}) as Record<string, any>;
  const title = String(fm.title ?? path.basename(rel, ".md"));
  const from = [meta.publication, meta.saved_at ? String(meta.saved_at).slice(0, 10) : null].filter(Boolean).join(", ");
  const about = String(meta.summary ?? meta.excerpt ?? "").replace(/\s+/g, " ").trim();
  // The member's notes on it: the fiche's « ## Commentaire » section
  // (data-api/services/gardenArticles.ts), up to the next heading.
  const notes = parsed.body.split(/^## Commentaire\s*$/m)[1]?.split(/^#{1,2} /m)[0] ?? "";
  const note = notes.replace(/\s+/g, " ").trim().slice(0, 600);
  const head = `— Article saved "${title}"${from ? ` (${from})` : ""}`;
  const room = Math.max(200, chars - head.length - note.length);
  return [head, about.length > room ? about.slice(0, room - 1).trimEnd() + "…" : about, note ? `Their note: ${note}` : ""]
    .filter(Boolean)
    .join("\n");
}
