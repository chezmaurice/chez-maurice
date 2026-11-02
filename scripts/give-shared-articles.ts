#!/usr/bin/env bun
/**
 * Give their copy to the members articles were shared with before sharing gave
 * one.
 *
 * Since 2 November 2026 sharing an article gives it: the member gets a fiche of
 * their own, with the text, the cover and the summaries (gardenArticles.ts,
 * copyArticleTo). Articles shared before that were only lent — read in the
 * owner's notes, without their text. This makes the copies once.
 *
 * Safe to re-run: a member who already has the article (same canonical URL)
 * gets nothing. The summary is brought up to date first, on the owner's
 * account, like at a share: one model call per article whose summary is
 * missing or old.
 *
 *   bun run scripts/give-shared-articles.ts          # every shared article
 *   bun run scripts/give-shared-articles.ts --dry    # say what it would do
 */
import db from "../server/src/db";
import { findArticleBySlug, readFullText, summarizeAndStore } from "../server/data-api/services/articleSummary";
import { copyArticleTo, findArticleFiche } from "../server/data-api/services/gardenArticles";
import { gardenFor } from "../server/data-api/services/gardenFiche";
import { memberBrief } from "../server/data-api/services/entryShares";

const dry = process.argv.includes("--dry");
const rows = db
  .query(
    `SELECT owner_id, locale, slug, member_id FROM entry_shares
      WHERE collection = 'articles' ORDER BY owner_id, locale, slug, created_at`,
  )
  .all() as { owner_id: string; locale: string; slug: string; member_id: string }[];

const tally: Record<string, number> = {};
const count = (k: string) => (tally[k] = (tally[k] ?? 0) + 1);
const summarised = new Set<string>();

for (const r of rows) {
  const owner = memberBrief(r.owner_id);
  let ref;
  try {
    ref = owner ? findArticleBySlug(r.owner_id, r.slug, r.locale) : null;
  } catch {
    ref = null;
  }
  if (!owner || !ref) {
    count("gone"); // shared, then deleted
    continue;
  }
  const theirs = gardenFor(r.member_id);
  if (theirs && findArticleFiche(theirs, ref.url, ref.canonical_url)) {
    count("exists");
    continue;
  }
  if (dry) {
    console.log(`would give ${r.locale}/${r.slug} from @${owner.username} to ${r.member_id}`);
    count("copied");
    continue;
  }
  const key = `${r.owner_id}/${r.locale}/${r.slug}`;
  if (!summarised.has(key) && readFullText(ref.file)) {
    summarised.add(key);
    await summarizeAndStore(r.owner_id, ref).catch((e) =>
      console.warn(`could not summarise ${key}: ${(e as Error).message}`));
  }
  count(copyArticleTo(owner, ref, r.member_id));
}
console.log(`${dry ? "(dry) " : ""}${rows.length} shares of articles:`, tally);
