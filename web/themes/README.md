# Themes

A **theme** is a folder of presentation files — layouts, styles, tokens, and
per-page-type view templates. It is completely separate from content (the
gardens). Switching themes is just **choosing a different folder**;
the content, routing, i18n, and privacy engine never change.

> **Authoring a new theme?** See [`AUTHORING.md`](./AUTHORING.md) for the full
> contract (token surface, view list + fallback, `theme.json` `kind`) and the
> brief template to hand a designer / Claude Design.

`default` is the neutral base + shared fallback (a `garden`-kind theme); other
themes override its tokens and views and inherit the rest. (`candide` — the
full-`site` reference — is private and overlaid in, not shipped publicly.)

## How selection works

Per request, not per build. Every theme's views and layouts are imported into
the engine (`src/lib/theme-registry.ts`), and `src/middleware.ts` picks one into
`Astro.locals.theme`, most specific first: `?theme=<id>` (remembered in a dated
cookie), that cookie while it is newer than the owner's choice, the owner's
choice in the app (`X-Maurice-Theme`, from `garden_settings.web_theme`), then
the `THEME` env, then `manuscript`.

- **`resolveView(theme, name)` / `resolveLayout(theme, name)`** return the
  active theme's component, falling back to `default`'s.
- **`@theme/<path>`** (a Vite plugin in `astro.config.mjs`) resolves against
  `themes/$THEME`, falling back to `themes/default`; **`@app`** → `src`.
- A static build has no request: it renders in `THEME`. `scripts/publish-web.sh`
  sets it to the garden's name (`candide`); a member's `/@<member>/` pages use
  `PUBLIC_PAGES_THEME`, by default `default`.

The app's picker lists every folder here with a `theme.json` that is not
`"hidden": true` (`GET /api/web-themes`). A new theme needs the engine rebuilt.

**The view follows the collection** (`notes/` → `NoteDetail`, `essays/` →
`EssayDetail`, …), never the note's frontmatter: there is no per-note template.

## What a theme owns

- `theme.json` — id, name, author, `kind` (`garden` | `site`), description,
  optionally `hidden`.
- `global.css` — the token set (`--color-*`, `--font-*`, spacing) + base typography.
- `layouts/Base.astro` — the page shell: `<head>`, fonts, dark-mode script, the
  chrome it includes, and the body structure. It renders the page into its
  default `<slot/>`.
- `views/*.astro` — per-page-type templates (Home, NoteDetail, EssayDetail,
  BookDetail, …), each optional; see `AUTHORING.md` for the list.

Themes pull engine pieces (content, i18n utils, shared chrome like `Nav`) from
`@app/...`.

## Authoring a new theme

1. Copy `themes/default/` to `themes/<your-id>/`.
2. Edit `theme.json`, `global.css`, and `layouts/Base.astro` (and later `views/`).
3. Rebuild the engine, then try it with `?theme=<your-id>`; a static build:
   `THEME=<your-id> npm run build`.

`src/layouts/Base.astro` is a shim that renders the active theme's `Base`
(`resolveLayout`) — no page or engine file needs to change to add a theme.
