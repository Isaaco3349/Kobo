// Builds the signed envelope the relayer accepts. Used by the browser (WebCrypto) and by the tests
// (node:crypto), so both run exactly the same code.
//   demo: ed25519 over canonical JSON of the call
//   live: real NEP-366 / NEP-461 SignedDelegateAction (sha256 of prefix + borsh), fixed gas, zero deposit
import { canonical } from "./lib.js";
import { delegateSigningPayload, hexToBytes, utf8, toBase64, GAS_30T } from "./borsh.js";

/**
 * prep   = what GET /api/prepare/:account returned ({nonce, expires_at_ms, max_block_height})
 * sha256 = async (Uint8Array) => Uint8Array
 * sign   = async (Uint8Array message) => Uint8Array(64)
 */
export async function buildEnvelope({ mode, sender, receiver, method, args, prep, sha256, sign }) {
  if (mode !== "live") {
    const delegate = { sender, receiver, method, args, nonce: prep.nonce, expires_at_ms: prep.expires_at_ms };
    return { delegate, signature: toBase64(await sign(utf8(canonical(delegate)))) };
  }
  const delegate = { sender, receiver, method, args, nonce: prep.nonce, max_block_height: prep.max_block_height };
  const payload = delegateSigningPayload({
    sender, receiver, method, args: utf8(canonical(args)), gas: GAS_30T,
    nonce: BigInt(prep.nonce), maxBlockHeight: BigInt(prep.max_block_height), publicKey: hexToBytes(sender),
  });
  return { delegate, signature: toBase64(await sign(await sha256(payload))) };
}
