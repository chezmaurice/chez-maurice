// ── What a turn is allowed to go and look up ────────────────────────────────
//
// A turn asked what Scoodle, Plantyn and Capture were — three proper nouns, one
// question — and searched the web six times and the corpus twice, in five
// rounds. Every search drew its own row of five source cards, so the member
// read a good answer under forty sources, six of the queries being the same
// question reworded:
//
//   Scoodle app école Belgique Plantyn qu'est-ce que c'est
//   Plantyn application école Belgique éditeur manuels scolaires
//   Capture app école Belgique primaire exercices
//   "Capture" application Plantyn ou école primaire Belgique exercices français
//   Scoodle Play Plantyn gratuit primaire exercices français maths
//   "Capture" Plantyn méthode français primaire Belgique grammaire ...
//
// Nothing stopped it. The only guard on the loop was MAX_TOOL_ROUNDS, six, and
// a round may hold any number of calls — so the ceiling on searches per turn
// was effectively none. This is the ledger that gives a turn a number.
//
// Two rules, and they do different jobs:
//
//   - **A budget**, per family. Four web searches answer any question a chat
//     turn is going to answer; a fifth is a model circling. The corpus gets
//     four, one per layer the prompt tells it to ask for (the people, the
//     garden, conversations, what they have only read).
//   - **A repeat check**, on the query itself: re-running a search spends a
//     round to receive the same pages twice. Of the fifteen pairs above, the
//     content-word overlap is 0.56 for queries three and four — the same
//     search, reworded — then 0.42, 0.36, and down. The threshold sits in that
//     gap. A first pass put it at 0.6 and caught nothing at all, which is the
//     whole reason the number is written here with its measurement: this net
//     is for the obvious case, and it was not even catching that.
//
// The budget is what does the work. Even with the repeat check calibrated, it
// is the budget that takes six searches down to four.
//
// Neither is an error. A tool that fails invites a retry, and a model told
// "error" here would try the other search tool, or the same one reworded. Both
// verdicts come back as an ordinary result saying what happened and what to do
// instead, which is: answer with what you already have.

export type SearchFamily = "web" | "corpus";

/** Per family, per turn. Four for the web; four for the corpus, one per layer
 *  the prompt asks it to search separately. */
const BUDGET: Record<SearchFamily, number> = { web: 4, corpus: 4 };

/** Above this overlap of content words, two queries are one question asked
 *  twice and the second is answered from the first. Between the reworded pair
 *  of the turn above (0.56) and the closest genuinely different pair (0.42). */
const SAME_QUESTION = 0.55;

/** Words that carry no subject and would make any two French or English
 *  questions look alike. Not a stopword list for retrieval — the query still
 *  goes to the search engine whole — only for comparing one query to another. */
const EMPTY = new Set(
  ("le la les un une des du de d au aux et ou où que qui quoi quel quelle quels quelles " +
    "est ce c'est sont a ai as avons avez ont pour par sur sous dans en y il elle ils " +
    "elles je tu nous vous me te se on ne pas plus moins comme avec sans mon ma mes ton " +
    "ta tes son sa ses notre nos votre vos leur leurs " +
    "the a an of to in on for with and or is are was were what which who how why when " +
    "it its this that these those do does did i you we they my your our their").split(" "),
);

/** Corpus searches that matched nothing *because of their filters* and are
 *  not charged, per turn. Past this, a miss costs like any search: a model
 *  guessing keys one after another is circling too. */
const FREE_MISSES = 2;

export interface SearchLedger {
  spent: Record<SearchFamily, number>;
  /** Filter misses let through without charge (see FREE_MISSES). */
  misses: number;
  /** One entry per search actually run this turn, newest last. */
  past: { family: SearchFamily; words: Set<string>; query: string; scope: string }[];
}

export function newSearchLedger(): SearchLedger {
  return { spent: { web: 0, corpus: 0 }, misses: 0, past: [] };
}

/** The content words of a query: lowercased, unaccented, punctuation gone,
 *  and the words that mean nothing on their own dropped. */
function words(query: string): Set<string> {
  const flat = query
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ");
  return new Set(flat.split(" ").filter((w) => w.length > 1 && !EMPTY.has(w)));
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export type SearchVerdict =
  | { run: true }
  | { run: false; text: string };

/**
 * May this turn run this search? Consulted before the call, and only for the
 * two search families — every other tool is unbudgeted.
 */
export function allowSearch(ledger: SearchLedger, family: SearchFamily, query: string, filters?: unknown): SearchVerdict {
  const asked = words(query);
  const where = scopeOf(filters);

  // The same words over another layer are another search: "ma comptable"
  // among the people and among the notes find different things — the first
  // her fiche, the second the mail about the accounts (27 September 2026,
  // when the people layer was refused as a repeat of the garden's).
  const twin = ledger.past.find((p) => p.family === family && p.scope === where && overlap(p.words, asked) >= SAME_QUESTION);
  if (twin) {
    return {
      run: false,
      text:
        `You already ran this search on this turn — "${twin.query}" — and its results are above. ` +
        `Rewording it returns the same pages. Answer from what you have, or say what is still missing.`,
    };
  }

  if (ledger.spent[family] >= BUDGET[family]) {
    const which = family === "web" ? "web searches" : "corpus searches";
    return {
      run: false,
      text:
        `No ${which} left on this turn — ${BUDGET[family]} is the budget, and the results of all of them are above. ` +
        `This is not a failure and not worth retrying with another tool: answer now with what you found, ` +
        `and say plainly what you could not establish rather than searching around it.`,
    };
  }

  return { run: true };
}

/** Called once a search has actually run. Kept separate from `allowSearch` so
 *  a refused call never counts against the budget it was refused by.
 *
 *  `found` is whether anything at all came back, before any narrowing. A
 *  semantic search with no filters always returns its nearest chunks, so an
 *  empty answer means the filters matched no document: the question was never
 *  asked of any text. On 17 November 2026 a turn after the exact passages of
 *  *Being You* filtered three times on keys the book's chunks did not carry,
 *  got three empty lists, and had spent its budget before asking once with
 *  the right key. Such a miss is remembered — the same search again is still
 *  a repeat — but not charged, up to FREE_MISSES a turn. */
export function recordSearch(ledger: SearchLedger, family: SearchFamily, query: string, filters?: unknown, found = true): void {
  const scope = scopeOf(filters);
  ledger.past.push({ family, words: words(query), query, scope });
  if (!found && scope && ledger.misses < FREE_MISSES) {
    ledger.misses += 1;
    return;
  }
  ledger.spent[family] += 1;
}

/** What the model reads after a corpus search its filters emptied: which
 *  keys each kind of document carries, and that the miss was free. */
export function filterMissNotice(filters: unknown): string {
  return (
    `Nothing in the corpus carries these filters: ${JSON.stringify(filters)}. No text was searched, ` +
    `and this did not count against your searches. The keys each kind carries — ` +
    `a book chapter (source_type "book"): title, author, book_title, chapter; ` +
    `a note, fiche, card or fragment: its frontmatter (title, author, collection, tags, year…); ` +
    `a conversation: conversation_id, conversation_title, date. ` +
    `A string matches as a substring. Ask again with a key the kind carries, or drop the one that matched nothing.`
  );
}

/** A search's filters as one comparable string: keys sorted, list values
 *  sorted, "" for none. */
function scopeOf(filters: unknown): string {
  if (!filters || typeof filters !== "object") return "";
  const norm = (v: unknown): unknown => (Array.isArray(v) ? v.map(String).sort() : v);
  return JSON.stringify(Object.keys(filters as object).sort().map((k) => [k, norm((filters as any)[k])]));
}
