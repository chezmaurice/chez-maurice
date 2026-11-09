import { api, connect, ext, forget, isConfigured, isSafari, loadConfig, originPattern, parseConnectInput } from "./ext.js";
import { lang, t } from "./strings.js";

/**
 * The server accepts 8 MB of HTML. Stay under it with room to spare for the
 * JSON envelope; past that we send no DOM and the server fetches the URL
 * itself, which is the pre-extension behaviour rather than a failure.
 */
const MAX_HTML = 7_000_000;

const el = (id) => document.getElementById(id);
const ua = navigator.userAgent;
const apple = /Macintosh|Mac OS X|iPhone|iPad/.test(ua);
const phone = /Android|iPhone|iPad|Mobile/.test(ua);
/** Safari on an iPhone draws its own sheet around the popup — the
 *  extension's name and a ✓ that closes it — so the popup has no bar. */
const iosSheet = apple && phone;

let config = null;
let captured = null;
let originGranted = true;

document.documentElement.classList.add(apple ? "apple" : "material");
if (phone) document.documentElement.classList.add("sheet");
document.documentElement.lang = lang;
for (const node of document.querySelectorAll("[data-t]")) node.textContent = t(node.dataset.t);
for (const node of document.querySelectorAll("[data-label]")) {
  node.setAttribute("aria-label", t(node.dataset.label));
  node.title = t(node.dataset.label);
}
el("shortcut").textContent = `${/Mac/.test(ua) ? "⌘↩" : "Ctrl+↩"} ${t("shortcut")}`;
el("address").placeholder = t("addressPlaceholder");

init();

async function init() {
  // Listeners first, values after: attached behind an await, the buttons
  // would be drawn but inert for as long as storage takes to answer.
  el("close").addEventListener("click", () => window.close());
  el("saved-close").addEventListener("click", () => window.close());
  el("save").addEventListener("click", save);
  el("save-check").addEventListener("click", save);
  el("fold").addEventListener("click", () => setFold(el("fold").getAttribute("aria-expanded") !== "true"));
  el("settings").addEventListener("click", showAccount);
  el("account-back").addEventListener("click", () => show("main"));
  el("disconnect").addEventListener("click", disconnect);
  el("connect-button").addEventListener("click", connectClicked);
  el("mic").addEventListener("click", toggleDictation);
  el("filed-change").addEventListener("click", toggleChoices);
  el("comment").addEventListener("input", () => { updateSummary(); keepDraft(); });
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !el("main").hidden) save();
  });
  config = await loadConfig();
  if (!isConfigured(config)) return showConnect();
  await showMain();
}

function show(id) {
  for (const view of document.querySelectorAll(".view")) view.hidden = view.id !== id;
}

// ── Connect ──────────────────────────────────────────────────────

function showConnect() {
  show("connect");
  el("address").focus();
  // A link pasted into either field fills both.
  for (const id of ["address", "code"]) {
    el(id).addEventListener("input", () => {
      const parsed = parseConnectInput(el("address").value, el("code").value);
      if (parsed.serverUrl && /[?&]code=/.test(el(id).value)) {
        el("address").value = new URL(parsed.serverUrl).host;
        el("code").value = parsed.code;
      }
    });
  }
}

function connectClicked() {
  const { serverUrl, code } = parseConnectInput(el("address").value, el("code").value);
  if (!serverUrl) return setStatus("connect-status", t("needAddress"), "bad");
  if (!code) return setStatus("connect-status", t("needCode"), "bad");
  // Asked for here, synchronously inside the click: browsers grant a host
  // permission only from a user gesture, and an await before it spends it.
  const asked = ext.permissions?.request
    ? ext.permissions.request({ origins: [originPattern(serverUrl)] })
    : Promise.resolve(true);
  finishConnect(asked, serverUrl, code);
}

async function finishConnect(asked, serverUrl, code) {
  if (!(await asked.catch(() => false))) return setStatus("connect-status", t("permissionDenied"), "bad");
  el("connect-button").disabled = true;
  setStatus("connect-status", t("connecting"), "muted");
  try {
    config = await connect(serverUrl, code);
  } catch (err) {
    el("connect-button").disabled = false;
    const message =
      err.message === "not-maurice" ? t("notMaurice")
      : err.status === 401 || err.status === 400 ? t("badCode")
      : err.status ? `${t("unreachable")} (${err.status})`
      : t("unreachable");
    return setStatus("connect-status", message, "bad");
  }
  setStatus("connect-status", "", "");
  await showMain();
}

// ── Account ──────────────────────────────────────────────────────

function showAccount() {
  const name = config.member?.name || "—";
  el("avatar").textContent = name.slice(0, 1).toUpperCase();
  if (config.member?.color) el("avatar").style.background = config.member.color;
  el("who-name").textContent = name;
  el("who-where").textContent = config.household || new URL(config.serverUrl).host;
  el("via-app").hidden = !config.fromApp;
  // The app's session is the app's to end.
  el("disconnect").hidden = Boolean(config.fromApp);
  show("account");
}

async function disconnect() {
  try { await api(config, "/api/auth/logout", { method: "POST" }); } catch { /* gone already */ }
  await forget();
  config = await loadConfig();
  if (isConfigured(config)) return showMain();
  showConnect();
}

// ── Save ─────────────────────────────────────────────────────────

async function showMain() {
  show("main");
  if (ext.permissions?.contains) {
    originGranted = await ext.permissions
      .contains({ origins: [originPattern(config.serverUrl)] })
      .catch(() => true);
  }

  try {
    captured = await capture();
  } catch (err) {
    // Browser pages, the extension stores, PDFs — scripting is refused there.
    el("title").textContent = t("cannotRead");
    el("host").textContent = String(err.message ?? err);
    el("save").disabled = el("save-check").disabled = true;
    return;
  }

  el("title").textContent = captured.title || captured.url;
  el("host").textContent = hostOf(captured.url);
  if (captured.image) el("thumb").style.backgroundImage = `url("${captured.image.replace(/"/g, "%22")}")`;
  el("full-page").hidden = !captured.html;
  if (captured.html && captured.html.length > MAX_HTML) {
    el("full-page").hidden = true;
    el("already").textContent = t("pageTooLarge");
    el("already").hidden = false;
  }

  const draft = await restoreDraft(captured.url);
  if (draft?.comment) el("comment").value = draft.comment;
  else if (captured.selection) el("comment").value = captured.selection;
  if (el("comment").value) setFold(true);
  updateSummary();

  checkAlreadySaved(captured.url);
  offerDictation();
}

/**
 * Read the rendered DOM out of the active tab.
 *
 * This is the whole reason the extension exists: the page is already loaded,
 * already past the paywall and the bot check that a server-side fetch would
 * meet. `activeTab` grants this only for the tab whose button was pressed,
 * and only until it navigates — no standing access to every site.
 */
async function capture() {
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab");
  const [result] = await ext.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const meta = (sel) => document.querySelector(sel)?.getAttribute("content") || "";
      let image = meta('meta[property="og:image"]') || meta('meta[name="twitter:image"]');
      try { image = image ? new URL(image, location.href).href : ""; } catch { image = ""; }
      return {
        url: location.href,
        title: meta('meta[property="og:title"]') || document.title,
        image,
        html: document.documentElement.outerHTML,
        selection: (window.getSelection()?.toString() ?? "").trim().slice(0, 2000),
      };
    },
  });
  if (!result?.result) throw new Error("Nothing could be read from this tab");
  return result.result;
}

async function checkAlreadySaved(url) {
  if (!originGranted) return;
  try {
    const { saved } = await api(config, `/api/v1/garden/articles/lookup?url=${encodeURIComponent(url)}`);
    if (!saved) return;
    el("already").textContent = t("already");
    el("already").hidden = false;
    el("save").textContent = t("addNote");
  } catch {
    // Not worth interrupting the save for: the server deduplicates again,
    // and that check is the authoritative one.
  }
}

function save() {
  if (!captured || el("save").disabled) return;
  // In Safari the connection comes from the app, and the address may not be
  // allowed yet: asked now, inside the click, like the connect screen does.
  const asked = !originGranted && ext.permissions?.request
    ? ext.permissions.request({ origins: [originPattern(config.serverUrl)] })
    : Promise.resolve(true);
  finishSave(asked);
}

async function finishSave(asked) {
  if (!(await asked.catch(() => false))) return setStatus("status", t("permissionDenied"), "bad");
  originGranted = true;
  el("save").disabled = el("save-check").disabled = true;
  setStatus("status", t("saving"), "muted");

  const html = captured.html && captured.html.length <= MAX_HTML ? captured.html : undefined;
  const comment = el("comment").value.trim() || undefined;
  const payload = {
    url: captured.url,
    html,
    title: captured.title || undefined,
    // The selection pre-fills the note, so sending it as well would write the
    // same passage into the fiche twice.
    selection: captured.selection && captured.selection !== comment ? captured.selection : undefined,
    comment,
    locale: lang,
    source_client: isSafari ? "safari" : /Firefox\//.test(ua) ? "firefox" : "chrome",
  };

  // Handed to the background so it survives this popup closing.
  let reply;
  try {
    reply = await ext.runtime.sendMessage({ type: "save-article", payload });
  } catch (err) {
    // The background could not start, or closed the channel before answering.
    reply = { ok: false, error: String(err?.message ?? err) };
  }

  if (!reply?.ok) {
    setStatus("status", `${t("saveFailed")} — ${reply?.error ?? ""}`, "bad");
    el("save").disabled = el("save-check").disabled = false;
    return;
  }
  await clearDraft();
  const { duplicate, needs_capture, fiche_web_path, slug, locale, domain, domain_choices } = reply.result;
  if (needs_capture) {
    setStatus("status", t("bookmark"), "bad");
    el("save").disabled = el("save-check").disabled = false;
    return;
  }
  el("saved-body").textContent = duplicate ? t("savedDuplicate") : t("savedBody");
  filed = { slug, locale, domain: domain ?? null, choices: domain_choices ?? [] };
  renderFiled();
  el("open-fiche").hidden = !fiche_web_path;
  el("open-fiche").onclick = async () => {
    await ext.tabs.create({ url: `${config.serverUrl}${fiche_web_path}` });
    window.close();
  };
  show("saved");
}

// ── The fold: the note ───────────────────────────────────────────

function setFold(open) {
  el("fold").setAttribute("aria-expanded", String(open));
  el("fold-body").hidden = !open;
  updateSummary();
  if (open) el("comment").focus();
}

function updateSummary() {
  const note = el("comment").value.trim();
  // On an iPhone the question sits above the card, as in Carnet's share
  // sheet: the row says what is in the note, or that it is optional.
  if (iosSheet) {
    const optional = t("optional");
    el("fold-summary").textContent = note.split("\n")[0] || optional.charAt(0).toUpperCase() + optional.slice(1);
    return;
  }
  const open = el("fold").getAttribute("aria-expanded") === "true";
  const noted = note ? t("note").toLowerCase() : t("optional");
  el("fold-summary").textContent = open ? "" : `· ${noted}`;
}

// ── The domain it was filed under ────────────────────────────────
//
// The server files a saved article under one of the member's domains, or
// none (server/src/services/domainArticles.ts). Said here, with the others
// to choose from; a member without domains sees nothing of it.

let filed = null;

function renderFiled() {
  const box = el("filed");
  if (!filed?.choices.length) { box.hidden = true; return; }
  box.hidden = false;
  const label = el("filed-label");
  if (filed.domain) {
    label.replaceChildren(`${t("filedIn")} `, Object.assign(document.createElement("b"), { textContent: filed.domain.name }));
  } else {
    label.textContent = t("filedNowhere");
  }
  el("filed-change").textContent = filed.domain ? t("change") : t("choose");
  const list = el("filed-choices");
  list.replaceChildren();
  for (const choice of [...filed.choices, { id: null, name: t("noDomain") }]) {
    const chip = document.createElement("button");
    chip.className = "chip plain";
    chip.setAttribute("role", "listitem");
    chip.textContent = choice.name;
    chip.setAttribute("aria-pressed", String(choice.id !== null && filed.domain?.id === choice.id));
    chip.addEventListener("click", () => chooseDomain(choice.id));
    list.append(chip);
  }
}

function toggleChoices() {
  const open = el("filed-choices").hidden;
  el("filed-choices").hidden = !open;
  el("filed-change").setAttribute("aria-expanded", String(open));
}

async function chooseDomain(id) {
  try {
    const answer = await api(config, `/api/v1/garden/articles/${encodeURIComponent(filed.slug)}/domain`, {
      method: "PUT",
      body: { domain_id: id, locale: filed.locale },
    });
    filed = { ...filed, domain: answer.domain ?? null };
    renderFiled();
    el("filed-choices").hidden = true;
    el("filed-change").setAttribute("aria-expanded", "false");
  } catch (err) {
    el("filed-label").textContent = `${t("changeFailed")} — ${err.message}`;
  }
}

// A popup vanishes when it loses focus — to grant the microphone in a tab, to
// look something up. What was typed is kept for this page until it is saved.
async function keepDraft() {
  if (!captured) return;
  await ext.storage.local.set({ draft: { url: captured.url, comment: el("comment").value } });
}
async function restoreDraft(url) {
  const { draft } = await ext.storage.local.get("draft");
  return draft?.url === url ? draft : null;
}
async function clearDraft() {
  await ext.storage.local.remove("draft");
}

// ── Dictation: the household's own (Whisper), as in the apps ─────

let recorder = null;
let chunks = [];
let startedAt = 0;

async function offerDictation() {
  if (!originGranted || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") return;
  try {
    const { available } = await api(config, "/api/dictation");
    el("mic").hidden = !available;
  } catch {
    el("mic").hidden = true;
  }
}

async function toggleDictation() {
  if (recorder?.state === "recording") return recorder.stop();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    // Chrome and Firefox do not ask for the microphone from a popup: the
    // question is put once in a tab of the extension's own, and holds after.
    if (!isSafari && err?.name === "NotAllowedError") {
      await keepDraft();
      setMicStatus(t("micNeedsTab"), true);
      await ext.tabs.create({ url: ext.runtime.getURL("mic.html") });
      return;
    }
    return setMicStatus(t("micRefused"), true);
  }
  const type = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"].find((m) => MediaRecorder.isTypeSupported?.(m));
  recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = () => {
    stream.getTracks().forEach((track) => track.stop());
    el("mic").classList.remove("on");
    el("mic").title = el("mic").ariaLabel = t("dictate");
    transcribe(new Blob(chunks, { type: recorder.mimeType || type || "audio/webm" }), (Date.now() - startedAt) / 1000);
  };
  recorder.start();
  startedAt = Date.now();
  el("mic").classList.add("on");
  el("mic").title = el("mic").ariaLabel = t("stopDictation");
  setMicStatus(t("listening"));
}

async function transcribe(blob, seconds) {
  setMicStatus(t("transcribing"), true);
  try {
    const { text } = await api(config, `/api/dictation?duration=${seconds.toFixed(1)}`, {
      method: "POST",
      raw: blob,
      contentType: blob.type.split(";")[0],
    });
    if (text?.trim()) {
      const box = el("comment");
      box.value = box.value.trim() ? `${box.value.trim()} ${text.trim()}` : text.trim();
      updateSummary();
      keepDraft();
    }
    setMicStatus("");
  } catch (err) {
    setMicStatus(`${t("dictationFailed")} — ${err.message}`, true);
  }
}

function setMicStatus(text, quiet = false) {
  const node = el("mic-status");
  node.textContent = text;
  node.hidden = !text;
  node.classList.toggle("quiet", quiet);
}

// ── Helpers ──────────────────────────────────────────────────────

function setStatus(id, text, className) {
  el(id).textContent = text;
  el(id).className = `status ${className ?? ""}`;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
