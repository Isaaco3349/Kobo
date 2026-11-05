// The exported key must be importable by real NEAR tooling and resolve to the same account.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { nearKeyFromJwk } from "../web/nearkey.js";
import { parseKey } from "../server/chain-live.js";

let C, ok = true;
try { C = await import("@near-js/crypto"); } catch { ok = false; }

async function browserStyleKey() {
  // exactly what the browser stores: WebCrypto Ed25519 private JWK + hex public key as account
  const pair = await crypto.webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const jwk = await crypto.webcrypto.subtle.exportKey("jwk", pair.privateKey);
  const raw = Buffer.from(await crypto.webcrypto.subtle.exportKey("raw", pair.publicKey));
  return { jwk, account: raw.toString("hex"), pair };
}

test("export gives NEAR format and the same account id", async () => {
  const { jwk, account } = await browserStyleKey();
  const k = nearKeyFromJwk(jwk);
  assert.match(k.privateKey, /^ed25519:[1-9A-HJ-NP-Za-km-z]+$/);
  assert.equal(k.accountId, account);
  assert.equal(parseKey(k.privateKey).pubStr, k.publicKey, "our own parser agrees");
});

test("a real NEAR library imports the exported key and derives the same account, and signs identically", { skip: !ok && "dev deps not installed" }, async () => {
  const { jwk, account, pair } = await browserStyleKey();
  const k = nearKeyFromJwk(jwk);
  const kp = C.KeyPair.fromString(k.privateKey);
  assert.equal(kp.getPublicKey().toString(), k.publicKey);
  assert.equal(Buffer.from(kp.getPublicKey().data).toString("hex"), account, "implicit account id = public key");
  // a signature made by the wallet library verifies against the browser's public key
  const msg = Buffer.from("withdraw test");
  const sig = kp.sign(msg).signature;
  const ver = await crypto.webcrypto.subtle.verify({ name: "Ed25519" }, pair.publicKey, sig, msg);
  assert.equal(ver, true);
});

test("rejects backups without a private key", () => {
  assert.throws(() => nearKeyFromJwk({ x: "abc" }), /private key/);
  assert.throws(() => nearKeyFromJwk(null), /private key/);
});
