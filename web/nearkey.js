// Converts the browser's Ed25519 key (WebCrypto JWK) into NEAR's text format, so the freelancer can
// import their account into any NEAR wallet and move their USDC out. Pure function: no storage, no DOM.
import { b58encode, bytesToHex } from "./borsh.js";

function b64uToBytes(s) {
  const b64 = String(s).replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(String(s).length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** @returns {{ privateKey: string, publicKey: string, accountId: string }}
 *  privateKey is "ed25519:<base58(seed + public key)>", the format NEAR wallets and the CLI import. */
export function nearKeyFromJwk(jwk) {
  if (!jwk || typeof jwk.d !== "string" || typeof jwk.x !== "string") throw new Error("This backup does not contain a private key");
  const seed = b64uToBytes(jwk.d);
  const pub = b64uToBytes(jwk.x);
  if (seed.length !== 32 || pub.length !== 32) throw new Error("Key has the wrong length");
  return {
    privateKey: "ed25519:" + b58encode(Uint8Array.from([...seed, ...pub])),
    publicKey: "ed25519:" + b58encode(pub),
    accountId: bytesToHex(pub), // an implicit account: the account id IS the public key
  };
}
