# Save to Carnet — the browser extension

One extension, the same code in every browser that takes one: it saves the
page you are reading into Carnet as an article fiche, with a note — typed or
dictated. No tags: the household files it under one of your domains, and
says which.

It exists for one reason the server cannot solve on its own: **it sends the
DOM your browser already rendered.** A server-side fetch of a Le Monde or NYT
article meets a paywall or a Cloudflare check and saves *that* page instead.
The page in your tab is already past all of it — your subscription included.

## Where it runs

| Browser | How it is installed |
|---|---|
| Chrome, Brave, Edge, Arc, Vivaldi (computer) | Chrome Web Store |
| Firefox (computer and Android) | Firefox Add-ons |
| Safari on iPhone and iPad | comes with **Carnet** (App Store) |
| Safari on the Mac | comes with **Maurice** for the Mac (App Store) |

Chrome and Brave on Android, and every browser on iPhone other than Safari,
take no extensions at all: there the share sheet to Carnet is what is left,
and it sends the URL only.

Until the store listings are up, load it unpacked: `chrome://extensions` →
Developer mode → **Load unpacked** → this directory; in Firefox,
`about:debugging` → **Load Temporary Add-on** → `manifest.json`.

## Connect it

In Safari there is nothing to do: the extension asks the app that carries it
(Carnet, or Maurice on the Mac) for the session it is signed in with.

Anywhere else, in the Maurice app: **Settings › Connect a browser**. It shows
a link, `https://<household>/join?code=ABCD-EFGH`, good once for ten minutes.
Paste it into the extension (or type the address and the code) and press
**Connect**. The code is traded for a session of this browser's own
(`POST /api/auth/enroll`); the browser asks once for permission to reach that
one address. **Disconnect**, in the extension's account view, ends that
session (`POST /api/auth/logout`).

## Use it

Press the toolbar button (Alt+Shift+S). The popup shows the article — its
picture, title and site — and says when it holds the whole text. **Why keep
this?** unfolds the note, with a microphone. **⌘/Ctrl+Enter** saves. If the
address is already in Carnet, saving again adds your note to the fiche instead
of making a twin. Once saved, the popup says which of your domains the article
went to — **Change** offers the others, or none — and **Open the fiche** goes
to it on the household's site.

Dictation is the household's own (`/api/dictation`, Whisper at home), as in the
apps: the browser records, the server writes it down in the language spoken.
Chrome and Firefox do not ask for the microphone from a popup, so the first
time the extension opens a tab of its own where the question is asked once.

## How it looks

Like the system it runs on, nothing of Maurice's own: Liquid Glass on Apple
devices, Material 3 elsewhere, light or dark as the system is
(`popup.css`, `html.apple` / `html.material`, `html.sheet` on a phone).

## How it is wired

| File | Role |
|---|---|
| `manifest.json` | MV3 — `activeTab`, `scripting`, `storage`, **optional** host permissions; a service worker for Chromium and Safari, an event page for Firefox |
| `ext.js` | The browser API under one name, the connection, the API client |
| `popup.html` / `popup.js` / `popup.css` | Connect, save, saved, account |
| `background.js` | Performs the save, so it survives the popup closing |
| `mic.html` / `mic.js` | The one-time microphone question, in a tab |
| `strings.js`, `_locales/` | French and English |

Decisions worth knowing:

**The DOM is read from the popup, never from a content script.** Content
scripts run in the page's own origin, where CORS applies and where the page's
own JavaScript could read the token. Extension contexts holding host permission
are exempt from CORS, and the page sees nothing.

**The save runs in the background.** A popup is destroyed the instant it loses
focus; a save that took its request with it would abort mid-commit on the
server. The background finishes either way and reports through the badge.

**The session lives in `storage.local`, not `sync`.** It is a credential to a
machine the household owns; syncing it through a browser vendor's account
would put it somewhere neither the member nor Maurice controls. In Safari it is
not stored at all: the app holds it.

## Packaging for the stores

`scripts/pack.sh` writes `dist/maurice-clipper-<version>.zip`, the same file
for the Chrome Web Store, Firefox Add-ons and Edge Add-ons. The Safari
extension is built by the apps' Xcode projects, which copy this directory in.
