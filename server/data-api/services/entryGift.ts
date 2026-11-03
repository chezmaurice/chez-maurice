/**
 * Giving an entry to someone in another household
 * (specs/cross-household-share.md, sections B and C).
 *
 * **Export, in household A.** Everything of the member's on one entry, element
 * by element, for the device to show and the member to tick: the source (an
 * article's captured text and styles, a book's catalogue record), the fiche's
 * prose and each dated note, their highlights, the card (even a draft), and
 * the conversations with Maurice about it — each saying whether it may leave
 * (only when the member is its one human). Read-only: nothing is written in A
 * and nothing records that it was read; A has nobody to tell.
 *
 * **Import, in household B.** What the device brings back, written as an
 * ordinary fiche in the caller's own notes there, built like an article copy
 * (gardenArticles.ts, copyArticleTo): source and picture copied, `meta.shared_by`
 * the caller, `meta.given_from` household A's name. The prose and the notes go
 * in as the caller's own; highlights become quotes, having no book position to
 * hang on there; the card is written as a draft whatever it was in A; each
 * conversation sent whole becomes a read-only conversation, one sent as its
 * summary a dated note. Then, with `share_with`, the entry is shared with that
 * member by the household's own live share (entryShares.ts).
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { guestCanReach } from "../../src/services/users";
import { hasBlocked } from "../../src/services/safety";
import {
  ConversationGiftError, humansOf, importConversation, readGivenMessages,
} from "../../src/services/conversationGift";
import { canonicalizeUrl, slugify, type StyledBlock } from "./articleExtract";
import { readTextStyles, writeTextStyles, type TextStyle } from "./articleCleanup";
import { readFullText } from "./articleSummary";
import { getBookMetadata, getCoverFile } from "./calibre";
import { copyArticleTo, findArticleFiche, scanArticleFiches } from "./gardenArticles";
import { conversationsAbout, keepGivenConversation } from "./entryConversations";
import { memberBrief, memberBriefByUsername, shareEntry } from "./entryShares";
import {
  assertLocale, assertSlug, autoCommit, fichePath, gardenFor, resourceImagePaths, writeFiche, writeFragment,
  type GardenRef, type ResourceCollection,
} from "./gardenFiche";
import { listGardenEntries } from "./gardenEntries";
import { indexGardenPaths } from "./gardenIndex";
import { noteBlock, withNote } from "./gardenNote";
import { getShelfEntry, readFace } from "./gardenShelf";
import { writeShared } from "./gardenWrite";

export class EntryGiftError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 413,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface EntryRef { collection: string; locale: string; slug: string }

/** The kinds that can be given: the shelf's, that have a fiche. */
const GIVABLE = ["books", "articles", "movies", "series", "music", "podcasts", "games"] as const;

/** What belongs to the member's reading of it, or to this household — never carried. */
const PRIVATE_META = [
  "opened", "opened_at", "read_at", "progress", "shared_by", "given_from", "calibre_id", "source_client",
  "capture_error", "image", "saved_at",
];

const MAX_PICTURE = 8 * 1024 * 1024;
const MAX_TEXT = 2_000_000;

// ── Pictures, as they travel ──

function mimeOf(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  return null;
}

function fileAsData(file: string | null): string | null {
  if (!file) return null;
  try {
    if (fs.statSync(file).size > MAX_PICTURE) return null;
    const bytes = new Uint8Array(fs.readFileSync(file));
    const mime = mimeOf(bytes);
    return mime ? `data:${mime};base64,${Buffer.from(bytes).toString("base64")}` : null;
  } catch {
    return null;
  }
}

/** A garden picture as the bytes themselves (a `data:` URI) — the other
 *  household cannot reach this one's files — or a web address as it is. */
function pictureOf(garden: GardenRef, url: string | null | undefined): string | null {
  if (!url) return null;
  if (/^https?:\/\//.test(url)) return url;
  const prefix = `/images/${garden.username}/`;
  if (!url.startsWith(prefix)) return null;
  const root = path.resolve(garden.root, "images");
  const file = path.resolve(root, url.slice(prefix.length));
  if (!file.startsWith(root + path.sep)) return null;
  return fileAsData(file);
}

function dataBytes(uri: string): Uint8Array | null {
  const m = uri.match(/^data:image\/(?:jpeg|jpg|png);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!m) return null;
  const bytes = new Uint8Array(Buffer.from(m[1]!, "base64"));
  if (!bytes.length || bytes.length > MAX_PICTURE || !mimeOf(bytes)) return null;
  return bytes;
}

// ── Export (household A) ──

export interface ExportedNote {
  id: string; date: string | null; author: string; text: string; quote?: string; page?: string; chapter?: string;
}

const noteId = (i: number, n: { date: string | null; text: string; quote?: string | null }) =>
  `n${i}-${createHash("sha1").update(`${n.date ?? ""}\n${n.text}\n${n.quote ?? ""}`).digest("hex").slice(0, 8)}`;

/** Plain values only: what a frontmatter can hold and another household can read. */
function plainMeta(meta: Record<string, any>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta ?? {})) {
    if (PRIVATE_META.includes(k) || v == null) continue;
    if (["string", "number", "boolean"].includes(typeof v)) out[k] = v;
    else if (Array.isArray(v) && v.every((x) => ["string", "number"].includes(typeof x))) out[k] = v;
  }
  return out;
}

export async function exportEntry(memberId: string, ref: EntryRef) {
  const garden = gardenFor(memberId);
  if (!garden) return null;
  const detail = await getShelfEntry(memberId, garden, ref.collection, ref.locale, ref.slug);
  if (!detail) return null;
  const e = listGardenEntries(garden).find(
    (x) => x.collection === ref.collection && x.locale === ref.locale && x.slug === ref.slug,
  );
  const fiche = readFace(garden, e?.fiche?.file);
  const card = readFace(garden, e?.card?.file);
  const meta = (fiche?.meta ?? {}) as Record<string, any>;
  const cover = pictureOf(garden, detail.image);

  let source: unknown = null;
  if (detail.source?.type === "article") {
    const file = e?.fiche ? path.join(garden.root, e.fiche.file) : null;
    const text = file ? readFullText(file) : "";
    source = {
      kind: "article",
      url: meta.url ?? card?.fm.url ?? detail.source.url ?? null,
      canonical_url: meta.canonical_url ?? null,
      text,
      styles: file && text ? readTextStyles(file, text) : [],
      ...(cover ? { image: cover } : {}),
    };
  } else if (ref.collection === "books") {
    const book = detail.source?.type === "book" ? await getBookMetadata(detail.source.book_id) : null;
    const bookCover = book ? fileAsData(await getCoverFile(book.id)) : null;
    source = {
      kind: "book",
      calibre: {
        title: book?.title ?? String(meta.title ?? detail.title),
        authors: book?.authors ?? (typeof meta.author === "string" ? meta.author.split(/\s*,\s*/).filter(Boolean) : []),
        ...(meta.isbn ? { isbn: String(meta.isbn) } : {}),
        ...((bookCover ?? cover) ? { cover: bookCover ?? cover } : {}),
      },
    };
  }

  // What the member wrote: their notes — never one another member signed on
  // a shared entry, whose words do not leave with theirs.
  const items = detail.mine?.items ?? [];
  const notes: ExportedNote[] = [];
  for (const item of items) {
    if (item.kind !== "note" && item.kind !== "quote") continue;
    if (item.author && item.author.id !== memberId) continue;
    notes.push({
      id: noteId(notes.length, item),
      date: item.date,
      author: garden.username,
      text: item.text,
      ...(item.quote ? { quote: item.quote } : {}),
      ...(item.where?.page ? { page: item.where.page } : {}),
      ...(item.where?.chapter_title ? { chapter: item.where.chapter_title } : {}),
    });
  }
  const highlights = items
    .filter((i) => i.kind === "highlight")
    .map((h: any) => ({
      id: h.id as string, date: h.date as string, text: h.quote as string,
      ...(h.where?.chapter_title ? { chapter: h.where.chapter_title as string } : {}),
      ...(h.text ? { note: h.text as string } : {}),
    }));

  const conversations = conversationsAbout(memberId, ref).map((c) => {
    const shareable = humansOf(c.id).every((h) => h === memberId);
    return {
      id: c.id, title: c.title ?? "Conversation", date: c.created_at, message_count: c.message_count,
      ...(c.summary?.text ? { summary: c.summary.text } : {}),
      shareable,
      ...(shareable ? {} : { reason: "others_took_part" }),
    };
  });

  return {
    entry: {
      collection: ref.collection, locale: ref.locale, slug: ref.slug,
      title: detail.title, kind: detail.kind, author: detail.byline,
      ...(cover ? { cover } : {}),
      date: detail.date, tags: detail.tags, rating: detail.rating,
      meta: plainMeta(meta),
    },
    source,
    fiche: { prose: detail.mine?.prose ?? "", notes },
    highlights,
    card: detail.shared
      ? {
          body: detail.shared.body, status: detail.shared.state,
          ...(detail.shared.state === "published" && detail.shared.public_url ? { url: detail.shared.public_url } : {}),
        }
      : null,
    conversations,
  };
}

// ── Import (household B) ──

const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const today = () => new Date().toISOString().slice(0, 10);
const dayOf = (s: unknown) => (isDay(s) ? s : typeof s === "string" && isDay(s.slice(0, 10)) ? s.slice(0, 10) : today());
const squash = (s: unknown) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
const isbnOf = (s: unknown) => String(s ?? "").replace(/[^0-9Xx]/g, "").toUpperCase();
const str = (v: unknown, max = 100_000) => (typeof v === "string" ? v.slice(0, max) : "");

/** The entry already in the caller's notes, when it is: the same article
 *  (canonical URL), the same book (ISBN, else title), the same work (title). */
function existing(garden: GardenRef, collection: string, title: string, url: string, isbn: string): EntryRef | null {
  if (collection === "articles" && url) {
    const found = findArticleFiche(garden, url);
    if (found) return { collection, locale: found.locale, slug: found.slug };
  }
  const all = listGardenEntries(garden).filter((e) => e.collection === collection);
  if (collection === "books" && isbn) {
    for (const e of all) {
      const f = readFace(garden, e.fiche?.file);
      const c = readFace(garden, e.card?.file);
      if ([f?.meta.isbn, f?.fm.isbn, c?.fm.isbn].some((v) => v && isbnOf(v) === isbn)) {
        return { collection, locale: e.locale, slug: e.slug };
      }
    }
  }
  if (collection === "articles") return null; // an article is known by its address alone
  const t = squash(title);
  const hit = all.find((e) => squash(e.title) === t);
  return hit ? { collection, locale: hit.locale, slug: hit.slug } : null;
}

function freeSlug(garden: GardenRef, collection: string, locale: string, base: string): string {
  const dir = path.join(garden.root, collection, locale);
  const taken = (s: string) => fs.existsSync(path.join(dir, `${s}-fiche.md`)) || fs.existsSync(path.join(dir, `${s}.md`));
  if (!taken(base)) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base.slice(0, 76).replace(/-+$/, "")}-${n}`;
    if (!taken(candidate)) return candidate;
  }
  throw new EntryGiftError("Could not find a free slug for this entry", 409);
}

/** Text styles as ranges (what the export gives) back into the per-block form they are stored in. */
function stylesToBlocks(text: string, styles: unknown): StyledBlock[] {
  const ranges = (Array.isArray(styles) ? styles : []).filter(
    (s: any): s is TextStyle => s && Number.isInteger(s.start) && Number.isInteger(s.end) && ["heading", "strong", "em"].includes(s.kind),
  );
  const out: StyledBlock[] = [];
  let at = 0;
  for (const block of text.split("\n\n")) {
    const start = at, end = at + block.length;
    const heading = block.length > 0 && ranges.some((r) => r.kind === "heading" && r.start <= start && r.end >= end);
    const spans = ranges
      .filter((r) => r.kind !== "heading" && r.start >= start && r.end <= end && r.start < r.end)
      .map((r) => [r.start - start, r.end - start, r.kind] as [number, number, "strong" | "em"]);
    out.push({ text: block, ...(heading ? { heading: true } : {}), spans });
    at = end + 2;
  }
  return out;
}

export interface ImportInput {
  entry?: any;
  source?: any;
  prose?: unknown;
  notes?: unknown;
  highlights?: unknown;
  card?: any;
  conversations?: unknown;
  share_with?: unknown;
  from_household?: unknown;
}

export async function importEntry(memberId: string, body: ImportInput): Promise<EntryRef> {
  const garden = gardenFor(memberId);
  const me = memberBrief(memberId);
  if (!garden || !me) throw new EntryGiftError("No notes for this member", 404);

  const from = str(body.from_household, 200).replace(/\s+/g, " ").trim().slice(0, 80);
  if (!from) throw new EntryGiftError("from_household required", 400);
  const entry = body.entry && typeof body.entry === "object" ? body.entry : null;
  if (!entry) throw new EntryGiftError("entry required", 400);
  const collection = String(entry.collection ?? "");
  if (!(GIVABLE as readonly string[]).includes(collection)) throw new EntryGiftError(`Not an entry that can be given: ${collection}`, 400);
  const title = str(entry.title, 300).replace(/\s+/g, " ").trim();
  if (!title) throw new EntryGiftError("entry.title required", 400);
  let locale: string;
  try {
    locale = assertLocale(String(entry.locale ?? "fr"));
  } catch {
    throw new EntryGiftError("invalid locale", 400);
  }
  const wanted = slugify(String(entry.slug ?? "")) || slugify(title) || collection.replace(/s$/, "");
  try {
    assertSlug(wanted);
  } catch {
    throw new EntryGiftError("invalid slug", 400);
  }

  // Whom to share it with, checked before anything is written.
  let target: ReturnType<typeof memberBrief> = null;
  if (body.share_with != null && body.share_with !== "") {
    // A username or a member id: Carnet holds either.
    const named = String(body.share_with).replace(/^@/, "");
    target = memberBrief(named) ?? memberBriefByUsername(named);
    if (!target) throw new EntryGiftError("Unknown member", 404);
    if (target.id === memberId) throw new EntryGiftError("The entry is already theirs", 400);
    if (!guestCanReach(memberId, target.id) || hasBlocked(target.id, memberId)) {
      throw new EntryGiftError("not_reachable", 403);
    }
  }

  const source = body.source && typeof body.source === "object" ? body.source : null;
  const article = collection === "articles" && source?.kind === "article" ? source : null;
  const book = collection === "books" && source?.kind === "book" && source.calibre && typeof source.calibre === "object" ? source.calibre : null;
  const url = article ? str(article.url, 4000).trim() : collection === "articles" ? str(entry.meta?.url, 4000).trim() : "";
  if (collection === "articles" && !/^https?:\/\//.test(url)) throw new EntryGiftError("an article needs its url", 400);
  const isbn = isbnOf(book?.isbn ?? entry.meta?.isbn);

  const already = existing(garden, collection, title, url, isbn);
  if (already) throw new EntryGiftError("exists", 409, { ...already });

  // The conversations, read before anything is written: one that will not
  // read refuses the whole gift rather than half of it.
  const convos: { title: string; date: string; summary: string; messages: ReturnType<typeof readGivenMessages> | null }[] = [];
  const rawConvos = Array.isArray(body.conversations) ? body.conversations : [];
  if (rawConvos.length > 50) throw new EntryGiftError("too many conversations", 413);
  for (const raw of rawConvos) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as any;
    // `mode`: "whole" brings its messages, "summary" its summary alone. Without
    // one, whatever came: messages make it whole.
    const whole = r.mode !== "summary";
    let messages: ReturnType<typeof readGivenMessages> | null = null;
    try {
      messages = whole && Array.isArray(r.messages) && r.messages.length ? readGivenMessages(r.messages) : null;
    } catch (e) {
      if (e instanceof ConversationGiftError) throw new EntryGiftError(e.message, e.status === 413 ? 413 : 400);
      throw e;
    }
    const summary = str(r.summary, 50_000).trim();
    if (!messages?.length && !summary) continue;
    convos.push({ title: str(r.title, 200).trim() || "Conversation", date: str(r.date, 40), summary, messages: messages?.length ? messages : null });
  }

  const slug = freeSlug(garden, collection, locale, wanted);
  const ref: EntryRef = { collection, locale, slug };
  const file = fichePath(garden, collection as ResourceCollection, locale, slug);
  const written: string[] = [];

  // The picture: the bytes when they came, a web address as it is.
  let image: string | undefined;
  for (const candidate of [article?.image, book?.cover, entry.cover]) {
    if (typeof candidate !== "string" || !candidate) continue;
    const bytes = candidate.startsWith("data:") ? dataBytes(candidate) : null;
    if (bytes) {
      const dest = resourceImagePaths(garden, collection as ResourceCollection, locale, slug);
      fs.mkdirSync(path.dirname(dest.file), { recursive: true });
      fs.writeFileSync(dest.file, bytes);
      written.push(dest.file);
      image = dest.url;
      break;
    }
    if (/^https?:\/\//.test(candidate)) {
      image = candidate.slice(0, 4000);
      break;
    }
  }

  // What the caller wrote in A: their prose, their notes, their highlights as
  // quotes, a conversation sent as its summary as a dated note.
  const blocks: { date: string; block: string }[] = [];
  for (const n of Array.isArray(body.notes) ? body.notes.slice(0, 2000) : []) {
    if (!n || typeof n !== "object") continue;
    const text = str((n as any).text), quote = str((n as any).quote);
    if (!text.trim() && !quote.trim()) continue;
    const date = dayOf((n as any).date);
    blocks.push({ date, block: noteBlock(date, { text, quote, where: { page: str((n as any).page, 40), chapter_title: str((n as any).chapter, 300) } }) });
  }
  for (const h of Array.isArray(body.highlights) ? body.highlights.slice(0, 5000) : []) {
    if (!h || typeof h !== "object") continue;
    const quote = str((h as any).text);
    if (!quote.trim()) continue;
    const date = dayOf((h as any).date);
    blocks.push({ date, block: noteBlock(date, { quote, text: str((h as any).note), where: { chapter_title: str((h as any).chapter, 300) } }) });
  }
  for (const c of convos) {
    if (c.messages) continue;
    const date = dayOf(c.date);
    blocks.push({ date, block: noteBlock(date, { text: `Conversation avec Maurice, ${date} — ${c.summary}` }) });
  }
  blocks.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const prose = str(body.prose).trim();
  const excerpt = article ? str(entry.meta?.excerpt, 2000).trim() : "";
  let fbody = [excerpt ? excerpt.split("\n").map((l) => `> ${l}`.trimEnd()).join("\n") : "", prose].filter(Boolean).join("\n\n");
  fbody = fbody ? `\n${fbody}\n` : "\n";
  for (const b of blocks) fbody = withNote(fbody, b.block);
  const wrote = !!prose || blocks.length > 0 || convos.length > 0;

  const day = today();
  const meta: Record<string, any> = {
    ...plainMeta(entry.meta ?? {}),
    ...(article ? {
      url,
      canonical_url: canonicalizeUrl(str(article.canonical_url, 4000) || url),
      status: "inbox",
    } : {}),
    ...(book ? {
      title: str(book.title, 300) || title,
      author: Array.isArray(book.authors) ? book.authors.map(String).join(", ") || undefined : undefined,
      isbn: isbn || undefined,
    } : {}),
    image,
    saved_at: day,
    shared_by: me.username,
    given_from: from,
    // Unopened only when nothing of the caller's came with it: an unopened
    // fiche shows nothing of what is written in it.
    opened: wrote ? undefined : false,
  };
  writeFiche(file, {
    title, resource_collection: collection, resource_id: slug, date: day,
    tags: Array.isArray(entry.tags) ? entry.tags.filter((t: unknown) => typeof t === "string").slice(0, 30) : [],
    locale, meta,
  }, fbody);
  written.push(file);

  // An article's captured text, its first fragment, with its styles beside it.
  const text = article ? str(article.text, MAX_TEXT + 1).trim() : "";
  if (text.length > MAX_TEXT) throw new EntryGiftError("the article's text is too long", 413);
  if (text) {
    const publication = String(meta.publication ?? new URL(url).hostname.replace(/^www\./, ""));
    written.push(writeFragment(file, `Texte intégral — ${publication}`, text));
    written.push(writeTextStyles(file, stylesToBlocks(text, article.styles)));
  }
  autoCommit(garden, written, `Entry given from ${from}: ${collection}/${slug}`);
  indexGardenPaths(memberId, written);

  // The card, a draft here whatever it was there: publishing is another act.
  const cardBody = str(body.card?.body).trim();
  if (cardBody) writeShared(memberId, garden, ref, { body: cardBody });

  // Each conversation sent whole: read-only here, held from the entry, with
  // the caller and the friend in it, and filed on the fiche with its summary.
  const refString = `${collection}/${locale}/${slug}`;
  const fragments: string[] = [];
  for (const c of convos) {
    if (!c.messages) continue;
    const id = importConversation(memberId, { title: c.title, date: c.date, messages: c.messages }, {
      fromHousehold: from, others: target ? [target.id] : [], entryRef: refString,
    });
    const frag = keepGivenConversation(memberId, ref, id, c.title, c.summary || null);
    if (frag) fragments.push(frag);
  }
  if (fragments.length) {
    autoCommit(garden, fragments, `Conversations given from ${from}: ${refString}`);
    indexGardenPaths(memberId, fragments);
  }

  // Shared as any entry is in this household — an article, given (a copy of
  // it in the friend's notes), as the participants route does.
  if (target) {
    shareEntry({ owner_id: memberId, ...ref }, target.id);
    if (collection === "articles") {
      const own = scanArticleFiches(garden).find((r) => r.slug === slug && r.locale === locale);
      if (own) copyArticleTo(me, own, target.id);
    }
  }
  return ref;
}
