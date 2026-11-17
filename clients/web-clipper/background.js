/**
 * The background owns the save.
 *
 * The popup could POST for itself, but a popup is destroyed the moment it loses
 * focus — press Save, glance at another window, and the request is aborted
 * halfway through a git commit on the server. Handing the work over means the
 * save completes whether or not anyone is still watching, and the toolbar
 * badge reports how it went.
 *
 * A service worker in Chromium and Safari, an event page in Firefox: the
 * manifest names this file for both.
 */

import { api, ext, finishHeldConnect, followColorScheme, loadConfig } from "./ext.js";

followColorScheme();

/**
 * The connection the popup set aside, finished here: the permission question
 * closed the popup that asked it. One attempt at a time — the popup, if it
 * survived, asks for the same thing, and the code is good only once.
 */
let finishing = null;

function finishConnect() {
  finishing ??= finishHeldConnect().finally(() => { finishing = null; });
  return finishing;
}

ext.permissions?.onAdded?.addListener(() => {
  finishConnect()
    .then((config) => { if (config) flashBadge("✓", "#2b7a3d"); })
    .catch(() => flashBadge("!", "#c0362c"));
});

ext.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "finish-connect") {
    finishConnect()
      .then((config) => sendResponse({ ok: true, connected: Boolean(config) }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message ?? error), status: error?.status ?? null }));
    return true;
  }
  if (message?.type !== "save-article") return false;

  saveArticle(message.payload)
    .then((result) => {
      flashBadge(result.duplicate ? "•" : "✓", "#2b7a3d");
      sendResponse({ ok: true, result });
    })
    .catch((error) => {
      flashBadge("!", "#c0362c");
      sendResponse({ ok: false, error: String(error?.message ?? error) });
    });

  return true; // keep the message channel open for the async reply
});

async function saveArticle(payload) {
  const config = await loadConfig();
  return api(config, "/api/v1/garden/articles", { method: "POST", body: payload });
}

function flashBadge(text, color) {
  // Not every browser draws a badge (Firefox on Android has no toolbar).
  if (!ext.action?.setBadgeText) return;
  ext.action.setBadgeText({ text });
  ext.action.setBadgeBackgroundColor?.({ color });
  setTimeout(() => ext.action.setBadgeText({ text: "" }), 4000);
}
