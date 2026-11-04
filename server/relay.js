// Gasless relayer (demo-mode envelope).
//
// The freelancer signs a "delegate action" locally with their own key. The relayer checks it
// and submits it, paying the gas. The relayer ONLY accepts calls to our own contract and only
// the allowlisted methods, and it identifies the user by the signed `sender`, never by who
// sent the HTTP request. This mirrors NEP-366 (meta transactions); in live mode the same checks
// run on a real borsh SignedDelegateAction (see server/near-live.js).
import crypto from "node:crypto";
import { canonical, HEX64 } from "../web/lib.js";
import { ChainError } from "./chain.js";

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export class RelayError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function verifyEd25519(publicKeyHex, message, signatureB64) {
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(publicKeyHex, "hex")]),
      format: "der",
      type: "spki",
    });
    return crypto.verify(null, Buffer.from(message), key, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

/**
 * envelope = { delegate: {sender, receiver, method, args, nonce, expires_at_ms}, signature(base64) }
 * The sender is an implicit NEAR account: its 64-hex account id IS its ed25519 public key.
 */
export function relay(chain, config, envelope, now = Date.now()) {
  const d = envelope && envelope.delegate;
  if (!d || typeof envelope.signature !== "string") throw new RelayError("Malformed relay request");
  if (!HEX64.test(d.sender || "")) throw new RelayError("sender must be a 64-hex implicit account");
  if (d.receiver !== config.contractId) throw new RelayError(`Relayer only pays for calls to ${config.contractId}`, 403);
  if (!config.relayAllowedMethods.includes(d.method)) throw new RelayError(`Method not sponsored: ${d.method}`, 403);
  if (!Number.isInteger(d.nonce) || d.nonce <= chain.lastNonce(d.sender)) throw new RelayError("Stale or replayed nonce", 409);
  if (!Number.isInteger(d.expires_at_ms) || d.expires_at_ms < now) throw new RelayError("Request expired", 408);
  if (d.expires_at_ms > now + config.relayMaxAgeMs) throw new RelayError("Expiry too far in the future");
  if (!verifyEd25519(d.sender, canonical(d), envelope.signature)) throw new RelayError("Bad signature", 401);
  if (chain.sponsorship(d.sender, now).calls_today >= config.relayDailyLimit) {
    throw new RelayError("Daily sponsored-call limit reached for this account", 429);
  }
  try {
    return chain.call({
      predecessor: d.sender, method: d.method, args: d.args || {},
      signer: config.relayerAccount || "kobo-relayer.testnet", relayed: true, nonce: d.nonce, now,
    });
  } catch (e) {
    if (e instanceof ChainError) throw new RelayError(`Contract rejected the call: ${e.message}`, 422);
    throw e;
  }
}
