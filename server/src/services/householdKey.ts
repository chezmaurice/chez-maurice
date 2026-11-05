/**
 * The household's identity key (not `secret.key`, which seals the mail): what
 * a device recognises the household by when its address changes.
 *
 * An Ed25519 pair, made once on the household's first boot and kept in
 * `households.identity_key`, so it travels with `maurice.db` in every archive
 * (the console's and the hosted one: it is the household's, not a member's
 * credential). `/api/health` serves the public half; a device pins it when it
 * pairs. When the household moves under another name, the old name's DNS
 * carries a TXT record pointing at the new address (docs/moving-a-household.md);
 * the device asks the new address to sign a nonce of its own and follows only
 * if the signature checks against the key it pinned. A forged TXT record can
 * point a device anywhere, but cannot make it move there.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import db from "../db";

const PROOF_CONTEXT = "maurice-household-proof:v1\n";

/** A nonce a device may ask to have signed: 16–128 base64url characters. */
export const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;

let cached: { priv: KeyObject; pub: string } | null = null;

function load(): { priv: KeyObject; pub: string } {
  if (cached) return cached;
  const row = db.query(`SELECT identity_key FROM households WHERE id = 'default'`).get() as { identity_key: string | null } | undefined;
  let pem = row?.identity_key ?? null;
  if (!pem) {
    pem = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    // Two processes booting at once must agree on one key: write only if still empty, then re-read.
    db.run(`UPDATE households SET identity_key = ? WHERE id = 'default' AND identity_key IS NULL`, [pem]);
    pem = (db.query(`SELECT identity_key FROM households WHERE id = 'default'`).get() as { identity_key: string }).identity_key;
  }
  const priv = createPrivateKey(pem);
  const pub = createPublicKey(priv).export({ format: "jwk" }).x as string;
  cached = { priv, pub };
  return cached;
}

/** The household's public key, raw 32 bytes as base64url. */
export function householdPublicKey(): string {
  return load().pub;
}

/** The household's signature of a device's nonce, base64url. */
export function proveHousehold(nonce: string): string {
  return sign(null, Buffer.from(PROOF_CONTEXT + nonce), load().priv).toString("base64url");
}

/** What a device does with the answer: true when `proof` is `key`'s signature of `nonce`. */
export function verifyHouseholdProof(key: string, nonce: string, proof: string): boolean {
  try {
    const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key }, format: "jwk" });
    return verify(null, Buffer.from(PROOF_CONTEXT + nonce), pub, Buffer.from(proof, "base64url"));
  } catch {
    return false;
  }
}

/** Forget the cached key (tests, and after an import replaced maurice.db under a running process). */
export function resetHouseholdKeyCache(): void {
  cached = null;
}
