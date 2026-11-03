/**
 * A note on the member's side of a fiche, as text: the dated block and where
 * it goes in the body. Pure functions, apart from gardenWrite.ts, so that a
 * writer which is not the shelf's — the Carnet suggestions
 * (src/services/entrySuggestions.ts) — files the same block without loading
 * the shelf and the reading services behind it.
 */

import { createHash } from "node:crypto";

export interface NoteInput {
  text?: string;
  quote?: string;
  /** A page (a book read on paper), or the chapter being read. */
  where?: { page?: string; chapter_title?: string };
  /**
   * The username of who wrote it, when that is not the garden's owner: a
   * member the entry is shared with. A note that names nobody is the owner's.
   */
  author?: string;
}

/** `@username` opening a note's head: who wrote it. */
export const NOTE_AUTHOR = /^@([A-Za-z0-9][A-Za-z0-9._-]*)(?:\s+—\s+([\s\S]*))?$/;

export const COMMENT_HEADING = "## Commentaire";

/**
 * A note changed after it was written keeps its date and says so at its end:
 * `… *(modifiée le 2026-11-03)*` — readable as is in Obsidian and on the web
 * garden, read back as the note's `edited` and stripped from its text. In a
 * block that holds a quote alone, the mark stands on its own line.
 */
export const EDIT_MARK = /\s*\*\(modifiée le (\d{4}-\d{2}-\d{2})\)\*\s*$/;
export const editMark = (day: string) => `*(modifiée le ${day})*`;

/** A note's text without its edit mark, and the day the mark gives. */
export function splitEdited(text: string): { text: string; edited: string | null } {
  const m = text.match(EDIT_MARK);
  return m ? { text: text.slice(0, m.index).trim(), edited: m[1]! } : { text, edited: null };
}

/**
 * A note's id: its block as written (date, signature, where, quote, text,
 * edit mark), hashed, and how many identical blocks come before it on the
 * fiche. Not its position: adding or deleting another note leaves it as is.
 */
export function noteIdOf(raw: string, occurrence: number): string {
  const normal = raw.split("\n").map((l) => l.trimEnd()).join("\n").trim();
  const hash = createHash("sha1").update(normal).digest("hex").slice(0, 12);
  return `n-${hash}-${occurrence}`;
}

/**
 * One dated block, in the two shapes the shelf reads back: `DATE — text` on a
 * line of its own, or `DATE — <where> :` followed by the quote and the text.
 * `edited` is the day it was last changed, written as the edit mark.
 */
export function noteBlock(date: string, input: NoteInput, edited?: string | null): string {
  // A line of the member's that opens like a heading would close the section.
  const safe = (s: string) => s.trim().replace(/^(#{1,6}\s)/gm, "\\$1");
  const text = safe(input.text ?? "");
  const quote = (input.quote ?? "").trim();
  const page = (input.where?.page ?? "").trim();
  const chapter = (input.where?.chapter_title ?? "").replace(/\s+/g, " ").trim();
  const where = page ? `p. ${page}` : chapter ? `ch. ${chapter}` : "";

  const author = (input.author ?? "").trim();
  const by = author ? `@${author} — ` : "";
  const mark = edited ? ` ${editMark(edited)}` : "";
  if (!quote && !where && !text.includes("\n")) return `${date} — ${by}${text}${mark}`;
  const blocks = [where ? `${date} — ${by}${where} :` : author ? `${date} — @${author} :` : `${date} :`];
  if (quote) blocks.push(quote.split("\n").map((l) => `> ${l}`.trimEnd()).join("\n"));
  if (text) blocks.push(`${text}${mark}`);
  else if (edited) blocks.push(editMark(edited));
  return blocks.join("\n\n");
}

/**
 * The body with a block added at the end of `## Commentaire` — the end of the
 * section, not of the file: résonances may follow, and a note left under their
 * heading would be read back as one.
 */
export function withNote(body: string, block: string): string {
  const lines = body.replace(/\s+$/, "").split("\n");
  const at = lines.findIndex((l) => l.trim() === COMMENT_HEADING);
  if (at < 0) {
    const head = lines.join("\n").replace(/^\n+/, "");
    return `\n${head ? `${head}\n\n` : ""}${COMMENT_HEADING}\n\n${block}\n`;
  }
  let end = lines.findIndex((l, i) => i > at && /^##\s/.test(l));
  if (end < 0) end = lines.length;
  const before = lines.slice(0, end).join("\n").replace(/\s+$/, "");
  const after = lines.slice(end).join("\n");
  return `\n${before.replace(/^\n+/, "")}\n\n${block}\n${after ? `\n${after}\n` : ""}`;
}
