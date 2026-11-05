/**
 * Apple pushes sealed for the device (November 2026). An Apple app that gives
 * keys with its token gets its pushes encrypted to them (RFC 8291, as Web
 * Push): Apple — and the push relay, for a household without the APNs key —
 * carries "New message" and a sealed blob, which the app's notification
 * extension opens. An app without keys keeps the clear payload.
 */
import { expect, test } from "bun:test";
import { MEMBER } from "./_member";

const { default: db } = await import("../src/db");
const { createSession } = await import("../src/services/auth");
const users = (await import("../src/routes/users")).default;
const { pushToUser, registerDeviceToken } = await import("../src/services/push");
const { applePayload, sendViaRelay, pushRelayURL, appFor } = await import("../src/services/apns");
const { b64urlDecode, b64urlEncode } = await import("../src/services/webpush");

const te = new TextEncoder();
const concat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
async function hmac(key: Uint8Array, data: Uint8Array) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

/** A device: its key pair and auth secret, and what its extension does with a seal. */
async function device() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  async function open(sealed: string): Promise<any> {
    const b = b64urlDecode(sealed);
    const salt = b.slice(0, 16), idlen = b[20], as = b.slice(21, 21 + idlen), ct = b.slice(21 + idlen);
    const asKey = await crypto.subtle.importKey("raw", as, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, pair.privateKey, 256));
    const ikm = await hmac(await hmac(auth, ecdh), concat(te.encode("WebPush: info\0"), pub, as, new Uint8Array([1])));
    const prk = await hmac(salt, ikm);
    const cek = (await hmac(prk, concat(te.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
    const nonce = (await hmac(prk, concat(te.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);
    const k = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, k, ct));
    return JSON.parse(new TextDecoder().decode(plain.slice(0, plain.lastIndexOf(2))));
  }
  return { keys: { p256dh: b64urlEncode(pub), auth: b64urlEncode(auth) }, open };
}

const session = createSession(MEMBER.id).token;
const register = (body: Record<string, unknown>) => users.request("/me/device-token", {
  method: "POST",
  headers: { Authorization: `Bearer ${session}`, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

test("an Apple app registers its token with keys; bad keys are refused", async () => {
  const d = await device();
  expect((await register({ token: "a1b2c3d4e5f6", platform: "carnet-ios", household_tag: "h9", keys: d.keys })).status).toBe(200);
  expect(db.query(`SELECT p256dh, auth FROM device_tokens WHERE token = 'a1b2c3d4e5f6'`).get()).toEqual(d.keys);
  expect((await register({ token: "a1b2c3d4e5f7", platform: "ios", keys: { p256dh: "BCVx", auth: "BTBZ" } })).status).toBe(400);
  db.run(`DELETE FROM device_tokens WHERE token = 'a1b2c3d4e5f6'`);
});

test("a device with keys gets a sealed push it can open; one without, the clear payload", async () => {
  const d = await device();
  registerDeviceToken(MEMBER.id, "sealed-tok", "ios", "h1", d.keys);
  registerDeviceToken(MEMBER.id, "clear-tok", "ios", "h1");
  const sent: Record<string, any> = {};
  await pushToUser(MEMBER.id, { title: "Candide", body: "On part à 8 h ?", conversationId: "c9" }, async (token, p) => {
    sent[token] = p;
    return { ok: true, status: 200 };
  });

  expect(await d.open(sent["sealed-tok"].sealed)).toEqual({ title: "Candide", body: "On part à 8 h ?", conversationId: "c9", householdTag: "h1" });
  // What Apple sees: the generic line and the seal, nothing else.
  expect(applePayload(sent["sealed-tok"])).toEqual({
    aps: { alert: { "loc-key": "New message" }, sound: "default", "mutable-content": 1 },
    sealed: sent["sealed-tok"].sealed,
  });

  expect(sent["clear-tok"].sealed).toBeUndefined();
  expect(applePayload(sent["clear-tok"])).toMatchObject({ aps: { alert: { title: "Candide", body: "On part à 8 h ?" } }, conversationId: "c9" });
  db.run(`DELETE FROM device_tokens WHERE user_id = ?`, [MEMBER.id]);
});

test("the relay is given the token, the app and the seal, and its answer is Apple's", async () => {
  let asked: { url: string; body: any } | null = null;
  const fake = (async (url: string, init: RequestInit) => {
    asked = { url, body: JSON.parse(String(init.body)) };
    return new Response(JSON.stringify({ ok: false, status: 410, reason: "Unregistered" }), { status: 200 });
  }) as unknown as typeof fetch;
  const r = await sendViaRelay("https://push.example", "tok", { title: "Candide", body: "secret", platform: "carnet-ios", sealed: "AAAA" }, fake);
  expect(asked!.url).toBe("https://push.example/v1/apns");
  expect(asked!.body).toEqual({ token: "tok", app: "carnet", sealed: "AAAA" });
  expect(r).toEqual({ ok: false, status: 410, reason: "Unregistered" });
  expect(appFor("ios")).toBe("maurice");
});

test("MAURICE_PUSH_RELAY_URL: a default, an override, and off", () => {
  const was = process.env.MAURICE_PUSH_RELAY_URL;
  delete process.env.MAURICE_PUSH_RELAY_URL;
  expect(pushRelayURL()).toBe("https://push.chezmaurice.eu");
  process.env.MAURICE_PUSH_RELAY_URL = "https://relay.example/";
  expect(pushRelayURL()).toBe("https://relay.example");
  process.env.MAURICE_PUSH_RELAY_URL = "off";
  expect(pushRelayURL()).toBeNull();
  process.env.MAURICE_PUSH_RELAY_URL = was;
});
