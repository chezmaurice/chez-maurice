/**
 * Tie a member's book fiches to the household library's books, once.
 *
 * A fiche is tied to its book by `meta.calibre_id`, written the first time the
 * server writes on a book of the library (gardenWrite.ts, entryForBook). The
 * fiches opened before that — from a conversation, from the catalogue — carry
 * no id, and are found by their title alone, when they are. This writes the id
 * on every fiche whose title and author name one book of the library only, and
 * lists the others: two editions, another author, a title the library has
 * under several books. Those the member settles.
 *
 *   bun run scripts/link-book-fiches.ts <username> [--apply]
 *   bun run scripts/link-book-fiches.ts <username> --apply --link <slug>=<calibre id> …
 *
 * Without `--apply` it prints the plan and changes nothing. `--link` ties a
 * fiche the member settled by hand. Safe to re-run: a fiche with an id is left
 * alone.
 */

import fs from "node:fs";
import path from "node:path";
import { getUserByUsername } from "../src/services/users";
import { autoCommit, gardenFor, parseFiche, writeFiche } from "../data-api/services/gardenFiche";
import { listGardenEntries } from "../data-api/services/gardenEntries";
import { indexGardenPaths } from "../data-api/services/gardenIndex";
import { loadLibrary, matchBook, readFace } from "../data-api/services/gardenShelf";

const args = process.argv.slice(2);
const username = args.find((a) => !a.startsWith("--") && !a.includes("="));
const apply = args.includes("--apply");
const byHand = new Map(
  args.filter((a) => /^[a-z0-9-]+=\d+$/.test(a)).map((a) => {
    const [slug, id] = a.split("=") as [string, string];
    return [slug, Number(id)];
  }),
);
if (!username) {
  console.error("usage: bun run scripts/link-book-fiches.ts <username> [--apply] [--link <slug>=<calibre id> …]");
  process.exit(2);
}
const member = getUserByUsername(username);
const garden = member ? gardenFor(member.id) : null;
if (!member || !garden) {
  console.error(`no garden for ${username}`);
  process.exit(1);
}

const lib = loadLibrary();
if (!lib.books.length) {
  console.error("the library is empty or unreadable: nothing to tie to");
  process.exit(1);
}

const sure: Array<{ file: string; slug: string; id: number; label: string }> = [];
const doubtful: string[] = [];
for (const e of listGardenEntries(garden).filter((e) => e.collection === "books" && e.fiche)) {
  const fiche = readFace(garden, e.fiche!.file);
  if (!fiche || fiche.meta.calibre_id != null) continue;
  const card = readFace(garden, e.card?.file);
  const author = String(fiche.meta.author ?? card?.fm.author ?? "") || null;
  const settled = byHand.get(e.slug);
  if (settled !== undefined) {
    const book = lib.byId.get(settled);
    if (!book) { doubtful.push(`  ${e.slug}: no book ${settled} in the library`); continue; }
    sure.push({ file: e.fiche!.file, slug: e.slug, id: book.id, label: `${book.title} — ${book.authors.join(", ")} (by hand)` });
    continue;
  }
  const { book, doubtful: maybe } = matchBook(lib, e.title, author);
  if (book) sure.push({ file: e.fiche!.file, slug: e.slug, id: book.id, label: `${book.title} — ${book.authors.join(", ")}` });
  else if (maybe.length) {
    doubtful.push(
      `  ${e.slug} « ${e.title} »${author ? ` (${author})` : ""} — ` +
        maybe.map((b) => `${b.id}: ${b.title} — ${b.authors.join(", ")}`).join(" | "),
    );
  }
}

console.log(`${sure.length} fiche(s) tied for sure:`);
for (const s of sure) console.log(`  ${s.slug} → ${s.id} ${s.label}`);
console.log(`${doubtful.length} to settle by hand (--link <slug>=<calibre id>):`);
for (const d of doubtful) console.log(d);

if (!apply) {
  console.log("\n(dry run: --apply writes the ids)");
  process.exit(0);
}
const written: string[] = [];
for (const s of sure) {
  const full = path.join(garden.root, s.file);
  const parsed = parseFiche(fs.readFileSync(full, "utf-8"));
  if (!parsed) continue;
  parsed.frontmatter.meta = { ...(parsed.frontmatter.meta ?? {}), calibre_id: s.id };
  writeFiche(full, parsed.frontmatter, parsed.body);
  written.push(full);
}
if (written.length) {
  autoCommit(garden, written, `Tie ${written.length} book fiche(s) to the library`);
  indexGardenPaths(member.id, written);
}
console.log(`\n${written.length} fiche(s) written.`);
