// What the notes' HTML keeps and loses, on the real pipeline.
//
//   bun scripts/check-sanitize.ts [note.md …]
//
// Without arguments it runs the fixed cases below (and exits non-zero on a
// failure); with paths it prints, per note, what the cleaning removed — the
// way to check a garden before a deploy that tightens the schema.
import fs from "node:fs";
import { createMarkdownProcessor } from "@astrojs/markdown-remark";
import { sanitizeHtml, sanitizeNotePlugins } from "../src/lib/sanitize";

const clean = await createMarkdownProcessor({ shikiConfig: { theme: "github-dark" }, rehypePlugins: sanitizeNotePlugins });
const raw = await createMarkdownProcessor({ shikiConfig: { theme: "github-dark" } });

// `@list.txt` reads one path per line.
const files = process.argv.slice(2).flatMap((a) =>
  a.startsWith("@") ? fs.readFileSync(a.slice(1), "utf-8").split("\n").filter(Boolean) : [a]);
if (files.length) {
  const tag = /<([a-zA-Z][\w-]*)|\s(on\w+)=/g;
  for (const f of files) {
    const body = fs.readFileSync(f, "utf-8").replace(/^---\n[\s\S]*?\n---\n/, "");
    const before = (await raw.render(body)).code;
    const after = (await clean.render(body)).code;
    const count = (html: string) => {
      const m = new Map<string, number>();
      for (const x of html.matchAll(tag)) m.set(x[1] ?? x[2], (m.get(x[1] ?? x[2]) ?? 0) + 1);
      return m;
    };
    const a = count(before), b = count(after);
    const lost = [...a].filter(([k, n]) => (b.get(k) ?? 0) < n).map(([k, n]) => `${k}×${n - (b.get(k) ?? 0)}`);
    console.log(`${lost.length ? "LOST" : "same"}  ${f}${lost.length ? "  " + lost.join(" ") : ""}`);
  }
  process.exit(0);
}

const cases: Array<[string, string, (html: string) => boolean]> = [
  ["script tag", "Avant <script>alert(1)</script> après", (h) => !h.includes("<script") && h.includes("après")],
  ["event handler", '<img src="x.png" onerror="alert(1)">', (h) => !h.includes("onerror") && h.includes("x.png")],
  ["javascript: link", "[clic](javascript:alert(1))", (h) => !h.includes("javascript:")],
  ["iframe", '<iframe src="https://evil.example"></iframe>', (h) => !h.includes("<iframe")],
  ["svg kept", '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="red"/></svg>', (h) => h.includes("<circle") && h.includes('viewBox="0 0 10 10"')],
  ["svg script", '<svg><script>alert(1)</script><circle onload="alert(1)" r="1"/></svg>', (h) => !h.includes("<script") && !h.includes("onload")],
  ["layout kept", '<div class="grid" style="display:grid" data-x="1"><span id="a">t</span></div>', (h) => h.includes('class="grid"') && h.includes("style=") && h.includes('data-x="1"') && h.includes('id="a"')],
  ["controls kept", '<button type="button">Go</button><select name="s"><option value="1">un</option></select><input type="range" min="0" max="5">', (h) => h.includes("<button") && h.includes("<option") && h.includes('type="range"')],
  ["mail link kept", "[source](maurice-mail:fp:abc)", (h) => h.includes('href="maurice-mail:fp:abc"')],
  ["code highlighted", "```js\nconst a = 1;\n```", (h) => h.includes("astro-code") && h.includes("style=")],
  ["heading ids", "## Un titre", (h) => h.includes('id="un-titre"')],
];

let failed = 0;
for (const [name, md, ok] of cases) {
  const html = (await clean.render(md)).code;
  const pass = ok(html);
  if (!pass) failed++;
  console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass ? "" : "\n     " + html}`);
}
const frag = sanitizeHtml('<p onclick="x()">a</p><script>b</script>');
const fragOk = frag === "<p>a</p>";
if (!fragOk) failed++;
console.log(`${fragOk ? "ok  " : "FAIL"} fragment${fragOk ? "" : "\n     " + frag}`);
console.log(`${cases.length + 1 - failed}/${cases.length + 1} passed`);
process.exit(failed ? 1 : 0);
