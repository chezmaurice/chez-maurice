/**
 * What the popup and the background share: the browser's API under one name,
 * where the connection lives, and how both talk to Maurice.
 *
 * One code base for Chrome (and every Chromium browser), Firefox — desktop and
 * Android — and Safari. Firefox and Safari expose `browser`, Chromium `chrome`;
 * all three answer the calls used here with promises under Manifest V3.
 *
 * The connection is in `storage.local`, never `sync`: the session token is a
 * credential to a machine the member's household owns, and syncing it through
 * a browser vendor's account would put it somewhere neither controls.
 */

export const ext = globalThis.browser ?? globalThis.chrome;

/**
 * The toolbar icon is a bare pipe on a transparent ground: dark for a light
 * browser, cream for a dark one. No manifest key for a dark variant works
 * across Chrome, Firefox and Safari, so the swap happens at run time, from
 * wherever `matchMedia` exists — the background page in Firefox and Safari,
 * and the popup everywhere (a Chromium service worker has no `matchMedia`).
 */
const SIZES = [16, 32, 48, 128];

export function followColorScheme() {
  if (typeof globalThis.matchMedia !== "function" || !ext.action?.setIcon) return;
  const query = globalThis.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    const name = query.matches ? "icon-dark" : "icon";
    const path = Object.fromEntries(SIZES.map((size) => [size, `icons/${name}-${size}.png`]));
    ext.action.setIcon({ path })?.catch?.(() => {});
  };
  apply();
  query.addEventListener?.("change", apply);
}

/** Safari hosts the extension inside an app (Carnet on iPhone and iPad,
 *  Maurice on the Mac), which already holds the member's session. */
export const isSafari =
  typeof navigator !== "undefined" &&
  /Safari\//.test(navigator.userAgent) &&
  !/Chrome\/|Chromium\/|Edg\/|Firefox\//.test(navigator.userAgent);

export async function loadConfig() {
  const stored = await ext.storage.local.get(["serverUrl", "token", "member", "household"]);
  const config = {
    serverUrl: (stored.serverUrl ?? "").replace(/\/+$/, ""),
    token: stored.token ?? "",
    member: stored.member ?? null,
    household: stored.household ?? null,
  };
  if (isConfigured(config) || !isSafari) return config;
  return (await fromHostApp()) ?? config;
}

export function isConfigured({ serverUrl, token }) {
  return Boolean(serverUrl && token);
}

export async function forget() {
  await ext.storage.local.remove(["serverUrl", "token", "member", "household"]);
}

/**
 * In Safari, ask the app that carries the extension for the session it is
 * signed in with — read from the app group it shares with its extension. The
 * answer is not stored here: the app stays the one place where the member
 * signs in and out, and a member switched in the app is the one who saves.
 */
async function fromHostApp() {
  try {
    const reply = await ext.runtime.sendNativeMessage("application.id", { type: "session" });
    if (!reply?.serverUrl || !reply?.token) return null;
    return {
      serverUrl: String(reply.serverUrl).replace(/\/+$/, ""),
      token: reply.token,
      member: reply.member ?? null,
      household: reply.household ?? null,
      fromApp: true,
    };
  } catch {
    return null;
  }
}

/** The origin pattern to ask `permissions` for, e.g. "https://host/*". */
export function originPattern(serverUrl) {
  const { protocol, host } = new URL(serverUrl);
  return `${protocol}//${host}/*`;
}

/**
 * Read what the member pasted: the link the app shows under *Connect a
 * browser* (`https://host/join?code=ABCD-EFGH`), or an address and a code
 * typed apart. Returns `{ serverUrl, code }`, either possibly empty.
 */
export function parseConnectInput(address, code) {
  let serverUrl = "";
  let found = (code ?? "").trim();
  for (const raw of [address, code]) {
    const text = (raw ?? "").trim();
    if (!/^https?:\/\/|\./.test(text) || /\s/.test(text)) continue;
    try {
      const url = new URL(/^https?:\/\//.test(text) ? text : `https://${text}`);
      serverUrl = `${url.protocol}//${url.host}`;
      const inLink = url.searchParams.get("code");
      if (inLink) found = inLink;
      else if (raw === code) found = "";
    } catch { /* not an address */ }
  }
  return { serverUrl, code: found.toUpperCase() };
}

/**
 * Trade a one-time code from the member's app for a session of this browser's
 * own (`POST /api/auth/enroll`, the route any new device of theirs uses), then
 * learn who and where it is, for the popup to say so.
 */
export async function connect(serverUrl, code) {
  const deviceId = `browser-${crypto.randomUUID()}`;
  const enrolled = await request(serverUrl, null, "/api/auth/enroll", {
    method: "POST",
    body: { code, device_id: deviceId },
  });
  if (!enrolled?.token) throw new Error(enrolled?.error ?? "No session came back");
  const me = await request(serverUrl, enrolled.token, "/api/users/me");
  const health = await request(serverUrl, null, "/api/health").catch(() => null);
  const config = {
    serverUrl,
    token: enrolled.token,
    member: { name: me.display_name || me.username || "", color: me.avatar_color ?? null },
    household: health?.household || null,
  };
  await ext.storage.local.set(config);
  return config;
}

/**
 * A connection waiting on the browser's permission.
 *
 * The question about the household's address closes the popup in Chrome and
 * Firefox — a popup dies the moment it loses focus — so the popup that asked
 * is gone by the time the member says yes. The address and the code are set
 * aside first; the background finishes the connection when the permission
 * arrives, and a popup opened later picks up whatever is left. In
 * `storage.session` where there is one: the code is good once, for ten
 * minutes, and has no business on disk.
 */
const held = () => ext.storage.session ?? ext.storage.local;

export function holdConnect(serverUrl, code) {
  return held().set({ pendingConnect: { serverUrl, code } });
}

export async function pendingConnect() {
  const { pendingConnect } = await held().get("pendingConnect");
  return pendingConnect ?? null;
}

/**
 * Trade the held code if the address is now allowed. Returns the new config,
 * or null when there is nothing to do; a failure stays held, with its reason,
 * for the next popup to show beside the address and the code.
 */
export async function finishHeldConnect() {
  const pending = await pendingConnect();
  if (!pending || pending.failed) return null;
  const granted = ext.permissions?.contains
    ? await ext.permissions.contains({ origins: [originPattern(pending.serverUrl)] }).catch(() => false)
    : true;
  if (!granted) return null;
  try {
    const config = await connect(pending.serverUrl, pending.code);
    await held().remove("pendingConnect");
    return config;
  } catch (err) {
    const failed = { message: err.message, status: err.status ?? null };
    await held().set({ pendingConnect: { ...pending, failed } });
    throw err;
  }
}

/**
 * A save takes a few seconds. Past SAVE_SLOW_MS the popup says it is still
 * waiting; at SAVE_TIMEOUT_MS the background gives up, so a connection that
 * dropped mid-upload ends in a message rather than "Saving…" for ever.
 */
export const SAVE_SLOW_MS = 10_000;
export const SAVE_TIMEOUT_MS = 30_000;

/** A request to Maurice with the member's session. */
export function api(config, pathname, options) {
  return request(config.serverUrl, config.token, pathname, options);
}

/**
 * Called only from extension pages and the background, never from a content
 * script: those run in the page's own origin under its CORS rules, where the
 * page's scripts could also read the token. Extension contexts holding host
 * permission for the server are exempt from CORS and out of the page's reach.
 */
export async function request(serverUrl, token, pathname, { method = "GET", body, raw, contentType, signal } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  if (raw) headers["Content-Type"] = contentType ?? "application/octet-stream";
  const response = await fetch(`${serverUrl}${pathname}`, {
    method,
    signal,
    headers,
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    // A non-JSON body means we did not reach the API — a proxy, a login page,
    // or the wrong address. Say that rather than "unexpected token <".
    throw Object.assign(new Error("not-maurice"), { status: response.status });
  }
  if (!response.ok) {
    throw Object.assign(new Error(payload?.error || `${response.status}`), { status: response.status });
  }
  return payload;
}
