/**
 * A book's title as two namings of it agree — the library's, a fiche's, a
 * conversation's. In a module of its own, imported by what may not load the
 * shelf (entrySuggestions.ts: the shelf reaches highlights.ts, which fixes
 * life.db's path when first loaded).
 */

/**
 * Accents, ligatures, case, punctuation, a leading article and a subtitle
 * aside: « The Gene: An Intimate History » is the library's « The Gene », and
 * « La Propension des choses. Pour une histoire… » its « La propension des
 * choses ».
 */
export function bookKey(title: string): string {
  const main = title.split(/\s*[:—–]\s+|\s+-\s+|\.\s+|\s*\(/)[0] || title;
  return main
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/œ/gi, "oe").replace(/æ/gi, "ae")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^(the|a|an|le|la|les|l|un|une) /, "");
}

/** The words of an author's names, for « Mukherjee » to find « Siddhartha Mukherjee ». */
function nameWords(names: string): Set<string> {
  return new Set(bookKey(names).split(" ").filter((w) => w.length > 1));
}

/** Whether `author` (as a fiche or a conversation names them) is one of
 *  `authors`: a surname in common is enough. No author said is no objection. */
export function sameAuthor(authors: string[], author: string | null | undefined): boolean {
  if (!author?.trim()) return true;
  const theirs = nameWords(authors.join(" "));
  return [...nameWords(author)].some((w) => theirs.has(w));
}
