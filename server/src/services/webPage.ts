// Reading one web page by its address — the counterpart of web_search, which
// only ever returns snippets. A member who says "look at chezmaurice.eu" used
// to be told to paste the text: the search engine had not indexed the site,
// and nothing else could open it.
//
// The fetch is the server's own, behind the SSRF guard of the article
// extractor (data-api/services/articleExtract.ts): no third party sees the
// address, the site sees the household's server as it would a browser, and
// the household's own network stays out of reach.

import {
  BROWSER_UA, safeFetch, extractArticleFromHtml, htmlToStyledBlocks, metaRefreshTarget, looksLikeInterstitial,
  type StyledBlock,
} from "../../data-api/services/articleExtract";
import type { SourceCard } from "./sourceCards";

/** What the model reads at most; the rest of a long page is cut, and said to be. */
export const MAX_PAGE_CHARS = 20_000;
/** Below this many words a page has nothing to read: built by JavaScript, or a wall. */
const THIN_WORDS = 40;
const MAX_HTML_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

export interface WebPage {
  url: string;
  title: string;
  site: string;
  description: string;
  text: string;
  words: number;
  /** The text was cut at MAX_PAGE_CHARS. */
  cut: boolean;
  /** Next to nothing came back: say so rather than guess. */
  thin: boolean;
}

export const READ_WEB_PAGE_TOOL = {
  name: "read_web_page",
  description:
    "Open a web page by its address and read its text. Use it when the member gives you a link or names a site, " +
    "or to read in full a page a web search turned up. Returns the page's title, final address and text (the main " +
    "content when the page is an article, the whole page otherwise; very long pages are cut). It cannot get past " +
    "paywalls, logins or bot checks, and a page built entirely by JavaScript may come back nearly empty: when that " +
    "happens, say so rather than guess what the page says.",
  input_schema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The page's address, e.g. https://chezmaurice.eu/ (a bare domain is read as https)." },
    },
    required: ["url"],
  },
};

/** "chezmaurice.eu/tarifs" → "https://chezmaurice.eu/tarifs"; anything with a scheme is left alone. */
export function normalizePageUrl(raw: string): string {
  const s = (raw ?? "").trim();
  if (!s) throw new Error("no address given");
  return /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s.replace(/^\/+/, "")}`;
}

export async function readWebPage(raw: string): Promise<WebPage> {
  let current = normalizePageUrl(raw);
  let html = "";
  let plain = false;

  // Two meta-refresh hops at most, as the article extractor does: a page that
  // moved that way otherwise reads as an empty "Redirect".
  for (let hop = 0; ; hop++) {
    const resp = await safeFetch(current, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
        "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (resp.url) current = resp.url;
    if (!resp.ok) throw new Error(`the site answered ${resp.status} ${resp.statusText}`.trim());
    const type = (resp.headers.get("content-type") ?? "").toLowerCase();
    if (type && !/(^|\/)(x?html|xml)|text\/plain/.test(type)) {
      throw new Error(`not a web page (${type.split(";")[0]})`);
    }
    plain = type.startsWith("text/plain");
    if (Number(resp.headers.get("content-length") ?? 0) > MAX_HTML_BYTES) throw new Error("the page is too large to read");
    html = await resp.text();
    if (html.length > MAX_HTML_BYTES) throw new Error("the page is too large to read");
    const refresh = !plain && hop < 2 ? metaRefreshTarget(html, current) : "";
    if (!refresh || refresh === current) break;
    current = refresh;
  }

  if (plain) return shape(current, "", "", "", html.trim());
  return pageFromHtml(current, html);
}

/** The page behind an address, from its HTML: what readWebPage does once fetched. */
export function pageFromHtml(url: string, html: string): WebPage {
  const article = extractArticleFromHtml(url, html);
  if (looksLikeInterstitial(article)) {
    throw new Error(`the site returned a bot check ("${article.title}") instead of the page`);
  }
  // Readability keeps an article's body and drops the rest — right for a news
  // piece, wrong for a landing page, whose every section is the content. When
  // it kept well under the page's own text, the page is read whole.
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
  const whole = blocksText(htmlToStyledBlocks(body));
  const kept = blocksText(article.blocks) || article.content;
  const text = countWords(kept) >= 0.6 * countWords(whole) ? kept : whole;
  return shape(url, article.title, article.site_name, article.description, text);
}

function blocksText(blocks: StyledBlock[]): string {
  return blocks.map((b) => (b.heading ? `## ${b.text}` : b.text)).join("\n\n");
}

function countWords(s: string): number {
  return s ? s.split(/\s+/).filter(Boolean).length : 0;
}

function shape(url: string, title: string, site: string, description: string, full: string): WebPage {
  const words = countWords(full);
  const cut = full.length > MAX_PAGE_CHARS;
  return {
    url, title, site, description, words, cut,
    text: cut ? full.slice(0, MAX_PAGE_CHARS) : full,
    thin: words < THIN_WORDS,
  };
}

/** The page as the model reads it. */
export function formatWebPage(p: WebPage): string {
  const head = [
    p.title && `Title: ${p.title}`,
    `Address: ${p.url}`,
    p.site && `Site: ${p.site}`,
    p.description && `Description: ${p.description}`,
  ].filter(Boolean).join("\n");
  const notes: string[] = [];
  if (p.thin) {
    notes.push(
      "[The page holds almost no readable text. It is probably built by JavaScript in the browser, or it is a " +
      "login or consent wall. Tell the member you could not read its content; do not describe it from its title.]",
    );
  }
  if (p.cut) notes.push(`[Cut at ${MAX_PAGE_CHARS.toLocaleString("en")} characters; the rest of the page (about ${p.words.toLocaleString("en")} words in all) is not shown.]`);
  return [head, p.text, ...notes].filter(Boolean).join("\n\n");
}

/** The card the app draws under the reply: the page read, as one source. */
export function webPageCard(p: WebPage): SourceCard {
  let host = "";
  try { host = new URL(p.url).hostname.replace(/^www\./, ""); } catch {}
  return {
    card: "sources", origin: "web", count: 1,
    results: [{
      title: p.title || host || p.url, kind: "web", url: p.url,
      ...(host ? { subtitle: host } : {}),
      ...(p.description ? { snippet: p.description.slice(0, 180) } : {}),
    }],
  };
}
