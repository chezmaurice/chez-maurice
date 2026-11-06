/**
 * The opening of a page's text, for the description a shared link shows when
 * the entry has none of its own: the rendered HTML down to plain words, cut at
 * a word near `max` characters.
 */
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function excerpt(html: string | null | undefined, max = 200): string | undefined {
  if (!html) return undefined;
  const text = html
    .replace(/<(script|style|figcaption|pre)\b[\s\S]*?<\/\1>/gi, " ")
    // A block's edge separates words; a link's or an emphasis's does not.
    .replace(/<\/?(p|div|li|ul|ol|h[1-6]|br|hr|blockquote|section|article|header|footer|tr|td|th|dt|dd)\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m;
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    })
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/, "")}…`;
}
