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
