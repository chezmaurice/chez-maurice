/**
 * The household's key (services/householdKey.ts): made once, kept in
 * maurice.db so it travels in every archive — the hosted one included — and
 * able to sign a device's nonce that only its own public half verifies.
 */
import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const db = (await import("../src/db")).default;
const { householdPublicKey, proveHousehold, verifyHouseholdProof, resetHouseholdKeyCache, NONCE_RE } = await import("../src/services/householdKey");
const { withoutCredentials } = await import("../src/services/archive");

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
});

const NONCE = "aBcD1234_efGH-5678ijkl";

test("the key is made once and kept: a fresh process reads the same one", () => {
  const first = householdPublicKey();
  expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 raw bytes
  resetHouseholdKeyCache();
  expect(householdPublicKey()).toBe(first);
  const row = db.query(`SELECT identity_key FROM households WHERE id = 'default'`).get() as any;
  expect(row.identity_key).toContain("PRIVATE KEY");
});

test("a proof verifies against the household's key, and nothing else does", () => {
  const key = householdPublicKey();
  const proof = proveHousehold(NONCE);
  expect(verifyHouseholdProof(key, NONCE, proof)).toBe(true);
  expect(verifyHouseholdProof(key, NONCE + "x", proof)).toBe(false);
  expect(verifyHouseholdProof(key, NONCE, proof.slice(0, -2) + "AA")).toBe(false);
  const stranger = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo"; // RFC 8032 test key 1
  expect(verifyHouseholdProof(stranger, NONCE, proof)).toBe(false);
  expect(verifyHouseholdProof("not a key", NONCE, proof)).toBe(false);
});

test("the hosted archive keeps the key: it is the household's, not a member's credential", () => {
  const dir = mkdtempSync(join(tmpdir(), "hk-archive-"));
  const snap = join(dir, "maurice.db");
  db.run(`VACUUM INTO ?`, [snap]);
  withoutCredentials(snap);
  const copy = new Database(snap);
  const row = copy.query(`SELECT identity_key FROM households WHERE id = 'default'`).get() as any;
  copy.close();
  const live = db.query(`SELECT identity_key FROM households WHERE id = 'default'`).get() as any;
  expect(row.identity_key).toBe(live.identity_key);
});

test("only a plain nonce of sane length may be asked for", () => {
  expect(NONCE_RE.test(NONCE)).toBe(true);
  for (const bad of ["short", "x".repeat(129), "has space in it 1234", "slash/slash/slash/1"]) expect(NONCE_RE.test(bad)).toBe(false);
});
