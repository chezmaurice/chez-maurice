/**
 * A conversation carried from one household to another
 * (specs/cross-household-share.md, sections B and E).
 *
 * In household A it is read out whole — only when the member asking is the one
 * human who took part: another member's words never leave. In household B it
 * is written back as a read-only conversation: the same messages (their text
 * and their data cards; no tool calls, no attachments in v1), the caller and
 * the friend as participants, marked with the name of the household it came
 * from. Nothing ties the two afterwards; no server talks to another — the
 * device signed into both carries it.
 */

import db from "../db";
import { getMaurice } from "./maurices";

export class ConversationGiftError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 413) {
    super(message);
  }
}

/** Every human who took part: the participants, and whoever wrote in it (a
 *  member who left still wrote what they wrote). */
export function humansOf(conversationId: string): string[] {
  const rows = db
    .query(
      `SELECT member_id AS id FROM conversation_participants WHERE conversation_id = ?
       UNION
       SELECT author_id AS id FROM messages WHERE conversation_id = ? AND author_id IS NOT NULL`,
    )
    .all(conversationId, conversationId) as { id: string }[];
  return rows.map((r) => r.id);
}

/** May this conversation leave the household, on this member's word? Only when
 *  they are the one human in it. */
export function isSoleHuman(conversationId: string, memberId: string): boolean {
  const humans = humansOf(conversationId);
  return humans.length > 0 && humans.every((h) => h === memberId);
}

export interface GivenMessage {
  role: "user" | "assistant";
  /** Who spoke: the member's display name, or the Maurice's. */
  author?: string;
  text: string;
  /** The data cards shown beside an answer, `[{ tool, data }]`. */
  data?: { tool: string; data: unknown }[];
  /** When it was said, ISO-8601. */
  at?: string;
}

export interface GivenConversation {
  title: string;
  date: string;
  messages: GivenMessage[];
}

/** SQLite's `datetime('now')` is UTC without saying so. */
const isoFromSqlite = (s: string) => (/[TZ]/.test(s) ? s : `${s.replace(" ", "T")}Z`);
const toSqlite = (iso: string) => new Date(iso).toISOString().replace("T", " ").slice(0, 19);

/** A picture attached to a message lives in this household's store: it does
 *  not travel (v1), and a link to it would lead nowhere over there. */
const LOCAL_IMAGE = /!\[[^\]]*\]\((?!https?:)[^)]*\)\n?/g;

export function exportConversation(conversationId: string, memberId: string): GivenConversation {
  const convo = db
    .query(
      `SELECT c.title, c.created_at FROM conversations c
         JOIN conversation_participants p ON p.conversation_id = c.id AND p.member_id = ?
        WHERE c.id = ?`,
    )
    .get(memberId, conversationId) as { title: string | null; created_at: string } | null;
  if (!convo) throw new ConversationGiftError("Not found", 404);
  if (!isSoleHuman(conversationId, memberId)) throw new ConversationGiftError("others_took_part", 403);

  const rows = db
    .query(
      `SELECT m.role, m.content, m.data, m.maurice_id, m.created_at, u.display_name
         FROM messages m LEFT JOIN users u ON u.id = m.author_id
        WHERE m.conversation_id = ? AND m.role != 'system'
        ORDER BY m.created_at, m.rowid`,
    )
    .all(conversationId) as Array<{
      role: "user" | "assistant"; content: string; data: string | null; maurice_id: string | null;
      created_at: string; display_name: string | null;
    }>;
  const names = new Map<string, string>();
  const mauriceName = (id: string | null) => {
    if (!id) return "Maurice";
    if (!names.has(id)) names.set(id, getMaurice(id)?.name ?? "Maurice");
    return names.get(id)!;
  };
  return {
    title: convo.title?.trim() || "Conversation",
    date: isoFromSqlite(convo.created_at),
    messages: rows.map((r) => {
      let data: GivenMessage["data"];
      try {
        const parsed = r.data ? JSON.parse(r.data) : null;
        if (Array.isArray(parsed) && parsed.length) data = parsed;
      } catch {}
      return {
        role: r.role,
        author: r.role === "assistant" ? mauriceName(r.maurice_id) : r.display_name ?? undefined,
        text: r.content.replace(LOCAL_IMAGE, "").trim(),
        ...(data ? { data } : {}),
        at: isoFromSqlite(r.created_at),
      };
    }),
  };
}

// ── Into household B ──

const MAX_MESSAGES = 2000;
const MAX_TEXT = 200_000;
const MAX_DATA = 200_000;

/** The messages a client sent, checked: roles, text, cards, times. */
export function readGivenMessages(raw: unknown): GivenMessage[] {
  if (!Array.isArray(raw)) throw new ConversationGiftError("messages must be a list", 400);
  if (raw.length > MAX_MESSAGES) throw new ConversationGiftError("too many messages", 413);
  const out: GivenMessage[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const role = (m as any).role;
    const text = String((m as any).text ?? "");
    if (role !== "user" && role !== "assistant") continue;
    if (text.length > MAX_TEXT) throw new ConversationGiftError("a message is too long", 413);
    let data: GivenMessage["data"];
    const d = (m as any).data;
    if (Array.isArray(d) && d.length) {
      const cards = d.filter((x: any) => x && typeof x.tool === "string");
      if (JSON.stringify(cards).length > MAX_DATA) throw new ConversationGiftError("a message's cards are too large", 413);
      if (cards.length) data = cards.map((x: any) => ({ tool: x.tool, data: x.data }));
    }
    const at = typeof (m as any).at === "string" && Number.isFinite(Date.parse((m as any).at)) ? (m as any).at : undefined;
    if (!text.trim() && !data) continue;
    out.push({ role, text: text.replace(LOCAL_IMAGE, "").trim(), ...(data ? { data } : {}), ...(at ? { at } : {}) });
  }
  return out;
}

/**
 * Write a given conversation into this household: owned by `ownerId` (the
 * member who brought it), with `others` as participants beside them, held
 * from the entry it was given with, read-only. The member's own words are
 * theirs here too; Maurice's answers are the everyday Maurice's. Returns its id.
 */
export function importConversation(
  ownerId: string,
  given: { title: string; date?: string; messages: GivenMessage[] },
  opts: { fromHousehold: string; others: string[]; entryRef: string },
): string {
  const id = crypto.randomUUID();
  const base = given.date && Number.isFinite(Date.parse(given.date)) ? Date.parse(given.date) : Date.now();
  // Times as they were said; one second apart where they were not sent.
  const times = given.messages.map((m, i) => (m.at ? toSqlite(m.at) : toSqlite(new Date(base + i * 1000).toISOString())));
  const created = times[0] ?? toSqlite(new Date(base).toISOString());
  const updated = times.at(-1) ?? created;
  db.transaction(() => {
    db.run(
      `INSERT INTO conversations (id, user_id, title, entry_ref, imported_from, read_only, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      [id, ownerId, given.title.slice(0, 200) || "Conversation", opts.entryRef, opts.fromHousehold, created, updated],
    );
    db.run(`INSERT INTO conversation_participants (conversation_id, member_id, role) VALUES (?, ?, 'owner')`, [id, ownerId]);
    for (const other of new Set(opts.others)) {
      if (other === ownerId) continue;
      db.run(`INSERT OR IGNORE INTO conversation_participants (conversation_id, member_id, role) VALUES (?, ?, 'member')`, [id, other]);
    }
    db.run(
      `INSERT OR IGNORE INTO conversation_entries (conversation_id, member_id, entry_ref) VALUES (?, ?, ?)`,
      [id, ownerId, opts.entryRef],
    );
    given.messages.forEach((m, i) => {
      db.run(
        `INSERT INTO messages (id, conversation_id, role, content, author_id, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [crypto.randomUUID(), id, m.role, m.text, m.role === "user" ? ownerId : null,
          m.data?.length ? JSON.stringify(m.data) : null, times[i]!],
      );
    });
  })();
  return id;
}
