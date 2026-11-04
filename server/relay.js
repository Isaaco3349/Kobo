// Gasless relayer policy. The freelancer signs a call locally with their own key; the relayer
// checks it and submits it, paying the gas. It ONLY sponsors allowlisted methods on OUR contract,
// capped per account per day, and it identifies the user by the signed `sender`, never by who
// made the HTTP request. The chain adapter then verifies the signature and nonce:
//   demo: canonical-JSON signature   |   live: real NEP-366 SignedDelegateAction (chain-live.js)
import { HEX64 } from "../web/lib.js";
import { RelayError } from "./errors.js";

export { RelayError };

export async function relay(chain, config, envelope, now = Date.now()) {
  const d = envelope && envelope.delegate;
  if (!d || typeof envelope.signature !== "string") throw new RelayError("Malformed relay request");
  if (!HEX64.test(d.sender || "")) throw new RelayError("sender must be a 64-hex implicit account");
  if (d.receiver !== config.contractId) throw new RelayError(`Relayer only pays for calls to ${config.contractId}`, 403);
  if (!config.relayAllowedMethods.includes(d.method)) throw new RelayError(`Method not sponsored: ${d.method}`, 403);
  if (typeof d.args !== "object" || d.args === null || Array.isArray(d.args)) throw new RelayError("args must be an object");
  if ((await chain.sponsorship(d.sender, now)).calls_today >= config.relayDailyLimit) {
    throw new RelayError("Daily sponsored-call limit reached for this account", 429);
  }
  return chain.submitDelegate(envelope, now);
}
