// Live NEAR chain adapter (same interface as MockChain). Zero dependencies.
//  * relayer  : wraps a freelancer's signed NEP-366 delegate action in a transaction and pays gas
//  * verifier : signs attest_payment / attest_refund calls with its own key
//  * provisioning: makes a brand-new freelancer account exist on-chain and registers it for USDC,
//    paid by the relayer, so the freelancer never needs to hold NEAR
import crypto from "node:crypto";
import { canonical, HEX64 } from "../web/lib.js";
import {
  GAS_30T, GAS_100T, delegateSigningPayload, encodeSignedDelegate, encodeTransaction, encodeSignedTransaction,
  b58decode, b58encode, hexToBytes, utf8, toBase64, nearToYocto,
} from "../web/borsh.js";
import { Rpc, RpcError, outcomeFailure, feeNear } from "./near-rpc.js";
import { ApiError, ChainError, RelayError } from "./errors.js";
import { verifyEd25519 } from "./chain.js";
import { sponsorship, recordSponsored } from "./sponsor.js";

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Parse "ed25519:<base58 of 64 bytes (seed+pub) or 32 bytes (seed)>". */
export function parseKey(str) {
  if (!str || !str.startsWith("ed25519:")) throw new Error('Private key must look like "ed25519:..."');
  const raw = b58decode(str.slice(8));
  if (raw.length !== 64 && raw.length !== 32) throw new Error("Private key has the wrong length");
  const seed = raw.slice(0, 32);
  const keyObj = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
  const pub = Uint8Array.from(Buffer.from(crypto.createPublicKey(keyObj).export({ format: "jwk" }).x, "base64url"));
  if (raw.length === 64 && b58encode(raw.slice(32)) !== b58encode(pub)) throw new Error("Private key's public half does not match its seed");
  return { pub, pubStr: "ed25519:" + b58encode(pub), sign: (bytes) => Uint8Array.from(crypto.sign(null, Buffer.from(bytes), keyObj)) };
}

export class LiveChain {
  constructor({ config, store, rpc = new Rpc(config.rpcUrl) }) {
    this.mode = "live";
    this.config = config;
    this.store = store;
    this.rpc = rpc;
    this.relayer = parseKey(config.relayerKey);
    this.verifier = parseKey(config.verifierKey);
    this._queues = new Map();
    this._prov = new Map();
    this.pollMs = 3000; // how often to look a transaction up after a timeout (tests lower this)
  }

  // ---- low level ------------------------------------------------------------------------------
  /** Run `fn` after earlier work for the same signer finishes (access-key nonces must not race). */
  _serial(account, fn) {
    const prev = this._queues.get(account) || Promise.resolve();
    const next = prev.then(fn, fn);
    this._queues.set(account, next.catch(() => {}));
    return next;
  }

  _send(signerId, key, receiver, actions) {
    return this._serial(signerId, async () => {
      const current = await this.rpc.accessKeyNonce(signerId, key.pubStr);
      if (current === null) throw new ApiError(`Key ${key.pubStr} is not an access key of ${signerId}`, 500);
      const block = await this.rpc.finalBlock();
      const txBytes = encodeTransaction({ signer: signerId, publicKey: key.pub, nonce: current + 1n, receiver, blockHash: b58decode(block.hash), actions });
      const hash = sha256(txBytes);
      const signed = encodeSignedTransaction(txBytes, key.sign(hash));
      try {
        return await this.rpc.sendTx(toBase64(signed), "EXECUTED");
      } catch (e) {
        // A real rejection from the network is final. A timeout or dropped connection is not: the
        // transaction may well have been accepted, so look it up by hash instead of failing or re-sending.
        if (e instanceof RpcError && !/TIMEOUT/i.test(e.cause_name + e.message)) throw e;
        const txHash = b58encode(hash);
        for (let i = 0; i < 10; i++) {
          await sleep(this.pollMs);
          try { return await this.rpc.call("tx", { tx_hash: txHash, sender_account_id: signerId, wait_until: "EXECUTED" }); } catch { /* not there yet */ }
        }
        throw e;
      }
    });
  }

  // ---- reads ----------------------------------------------------------------------------------
  async view(id) { return this.rpc.viewFunction(this.config.contractId, "get_invoice", { id }); }
  async getTx() { return null; } // receipts link to the public NEAR explorer in live mode
  async sponsorship(account, now = Date.now()) { return sponsorship(this.store, account, now); }

  // ---- verifier-signed calls ------------------------------------------------------------------
  async call({ method, args, now = Date.now() }) {
    const result = await this._send(this.config.verifierId, this.verifier, this.config.contractId, [
      { type: "FunctionCall", method, args: utf8(canonical(args)), gas: GAS_30T, deposit: 0n },
    ]);
    const hash = result.transaction?.hash;
    const fail = outcomeFailure(result);
    const tx = { hash, ts: now, method, args, predecessor: this.config.verifierId, signer: this.config.verifierId, relayed: false, outcome: fail ? "Failure" : "SuccessValue", error: fail };
    if (fail) { const e = new ChainError(fail); e.tx = tx; throw e; }
    return tx;
  }

  /** Move USDC from KOBO's balance inside intents.near to the freelancer's NEAR account (verifier signs). */
  async withdrawToOwner({ to, amount }) {
    const token = this.config.usdcContract || "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
    const args = { token, receiver_id: to, amount: String(amount) }; // no `msg`: a failed transfer is refunded, not lost
    const result = await this._send(this.config.verifierId, this.verifier, this.config.intentsContract, [
      { type: "FunctionCall", method: "ft_withdraw", args: utf8(canonical(args)), gas: GAS_100T, deposit: 1n },
    ]);
    const fail = outcomeFailure(result);
    if (fail) throw new ApiError(`Withdrawal from NEAR Intents failed: ${fail}`, 502);
    return { hash: result.transaction?.hash, args };
  }

  // ---- account provisioning (relayer pays) ----------------------------------------------------
  ensureAccount(account, hooks = {}) {
    if (!this._prov.has(account)) {
      const p = this._ensureAccount(account, hooks).finally(() => this._prov.delete(account));
      this._prov.set(account, p);
    }
    return this._prov.get(account);
  }

  async _ensureAccount(account, hooks = {}) {
    const out = { created: false, registered: false };
    let counted = false; // the caller's rate limit is charged once, and only when we really spend the relayer's money
    const charge = () => { if (!counted) { counted = true; hooks.beforeProvision?.(); } };
    const relayerId = this.config.relayerAccount;
    if (!(await this.rpc.viewAccount(account))) {
      charge();
      const r = await this._send(relayerId, this.relayer, account, [{ type: "Transfer", deposit: nearToYocto(this.config.fundNear) }]);
      const fail = outcomeFailure(r);
      if (fail) throw new ApiError(`Could not create the freelancer's account: ${fail}`, 502);
      out.created = true;
    }
    const usdc = this.config.usdcContract;
    if (usdc) {
      let bal;
      try { bal = await this.rpc.viewFunction(usdc, "storage_balance_of", { account_id: account }); } catch { bal = undefined; }
      if (bal === null) { // reachable and not registered yet
        charge();
        const bounds = await this.rpc.viewFunction(usdc, "storage_balance_bounds", {});
        const r = await this._send(relayerId, this.relayer, usdc, [
          { type: "FunctionCall", method: "storage_deposit", args: utf8(canonical({ account_id: account, registration_only: true })), gas: GAS_30T, deposit: BigInt(bounds.min) },
        ]);
        const fail = outcomeFailure(r);
        if (fail) throw new ApiError(`Could not register the account for USDC: ${fail}`, 502);
        out.registered = true;
      }
    }
    return out;
  }

  /** Called before the freelancer signs: makes sure the account exists, returns nonce + expiry. */
  async prepare(account, now = Date.now(), hooks = {}) {
    if (!HEX64.test(account)) throw new ApiError("Bad account");
    await this.ensureAccount(account, hooks);
    const nonce = await this.rpc.accessKeyNonce(account, "ed25519:" + b58encode(hexToBytes(account)));
    if (nonce === null) throw new ApiError("Your account's key is not visible on-chain yet. Try again in a few seconds.", 503);
    const block = await this.rpc.finalBlock();
    return { nonce: Number(nonce) + 1, expires_at_ms: now + 5 * 60 * 1000, max_block_height: block.height + 300 };
  }

  // ---- relayed (gasless) calls ----------------------------------------------------------------
  /**
   * envelope = { delegate: {sender, receiver, method, args, nonce, max_block_height}, signature(base64) }
   * We rebuild the exact NEP-366 DelegateAction ourselves, with OUR fixed gas and zero deposit, so
   * the user cannot make the relayer pay for anything but this one capped call.
   */
  async submitDelegate(envelope, now = Date.now()) {
    const d = envelope.delegate;
    if (!Number.isSafeInteger(d.nonce) || d.nonce <= 0) throw new RelayError("Bad nonce");
    if (!Number.isSafeInteger(d.max_block_height) || d.max_block_height <= 0) throw new RelayError("Bad max_block_height");
    const sig = Buffer.from(envelope.signature, "base64");
    if (sig.length !== 64) throw new RelayError("Signature must be 64 bytes", 401);

    const dd = {
      sender: d.sender, receiver: d.receiver, method: d.method, args: utf8(canonical(d.args)), gas: GAS_30T,
      nonce: BigInt(d.nonce), maxBlockHeight: BigInt(d.max_block_height), publicKey: hexToBytes(d.sender),
    };
    if (!verifyEd25519(d.sender, sha256(delegateSigningPayload(dd)), envelope.signature)) throw new RelayError("Bad signature", 401);

    const block = await this.rpc.finalBlock();
    if (d.max_block_height <= block.height) throw new RelayError("Request expired", 408);
    if (d.max_block_height > block.height + 1000) throw new RelayError("Expiry too far in the future");
    if (!(await this.rpc.viewAccount(d.sender))) throw new RelayError("Account is not set up yet; call /api/prepare first", 409);

    const result = await this._send(this.config.relayerAccount, this.relayer, d.sender, [{ type: "SignedDelegate", bytes: encodeSignedDelegate(dd, sig) }]);
    const fail = outcomeFailure(result);
    if (fail) throw new RelayError(`Contract rejected the call: ${fail}`, /nonce/i.test(fail) ? 409 : 422);

    const fee = feeNear(result);
    recordSponsored(this.store, d.sender, fee, now);
    return {
      hash: result.transaction.hash, ts: now, signer: this.config.relayerAccount, predecessor: d.sender, receiver: d.receiver,
      method: d.method, args: d.args, relayed: true, outcome: "SuccessValue", error: null, sim_fee_near: fee,
    };
  }
}
