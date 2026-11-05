// What a note may carry as HTML. Notes are written by members, by Maurice, and
// from clipped pages and mail, and they render on the household's own origin —
// the one /api answers on — so a `<script>` or an `onerror=` in a note would act
// with the reader's session. Everything goes through this schema: GitHub's
// defaults, widened to what gardens actually hold (layout divs, inline SVG
// diagrams, inert form controls, Shiki's styled spans, maurice-mail: links),
// minus scripts, event handlers and javascript: URLs, which no schema allows.
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize";
import rehypeParse from "rehype-parse";
import rehypeStringify from "rehype-stringify";
import { unified, type PluggableList } from "unified";

const SVG_TAGS = [
  "svg", "g", "defs", "title", "desc", "path", "circle", "ellipse", "line", "polyline",
  "polygon", "rect", "text", "tspan", "marker", "linearGradient", "radialGradient", "stop",
];

const SVG_ATTRIBUTES = [
  "viewBox", "xmlns", "width", "height", "fill", "fillOpacity", "fillRule", "stroke",
  "strokeWidth", "strokeLinecap", "strokeLinejoin", "strokeDasharray", "strokeOpacity",
  "opacity", "d", "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "y1", "x2", "y2", "dx", "dy",
  "points", "transform", "textAnchor", "dominantBaseline", "fontSize", "fontFamily",
  "fontWeight", "preserveAspectRatio", "markerEnd", "markerStart", "refX", "refY",
  "markerWidth", "markerHeight", "orient", "offset", "stopColor", "stopOpacity",
  "gradientUnits",
];

const base = defaultSchema.attributes ?? {};

export const noteSchema: SanitizeSchema = {
  ...defaultSchema,
  // Ids stay as written: headings get theirs after this pass, and notes link
  // to their own anchors.
  clobber: [],
  clobberPrefix: "",
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    ...SVG_TAGS,
    "button", "select", "option", "label", "nav", "figure", "figcaption", "mark", "abbr",
    "small", "u", "time", "header", "footer", "section", "aside", "article",
  ],
  attributes: {
    ...base,
    "*": [...(base["*"] ?? []), "className", "id", "style", "title", "role", "tabIndex", "data*", "aria*"],
    a: [...(base.a ?? []), "target", "rel"],
    img: [...(base.img ?? []), "loading", "width", "height", "decoding"],
    input: ["type", "name", "value", "placeholder", "checked", "disabled", "min", "max", "step"],
    button: ["type", "name", "value", "disabled"],
    select: ["name", "multiple", "disabled"],
    option: ["value", "selected", "disabled"],
    label: ["htmlFor"],
    time: ["dateTime"],
    ...Object.fromEntries(SVG_TAGS.map((t) => [t, SVG_ATTRIBUTES])),
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "maurice-mail", "maurice", "note", "obsidian", "tel"],
  },
  // GitHub's defaults force type=checkbox and disabled on every input; notes
  // carry other kinds of inert controls.
  required: {},
};

/** For a markdown processor's rehypePlugins: Astro only applies rehype-raw
 *  after the user plugins, so raw HTML is parsed here first, then cleaned. */
export const sanitizeNotePlugins: PluggableList = [rehypeRaw, [rehypeSanitize, noteSchema]];

const fragmentProcessor = unified()
  .use(rehypeParse, { fragment: true })
  .use(rehypeSanitize, noteSchema)
  .use(rehypeStringify);

/** The same cleaning for HTML that came from elsewhere (marked, fragments). */
export function sanitizeHtml(html: string): string {
  return String(fragmentProcessor.processSync(html));
}
