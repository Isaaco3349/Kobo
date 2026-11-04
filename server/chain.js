// Demo-mode ledger. It enforces exactly the same rules as contract/src/lib.rs, so the
// demo behaves like the real contract: ownership by predecessor, verifier-only attestations,
// no double payment, no paying less than the invoice amount.
//
// Chain interface (implemented by MockChain here and LiveChain in chain-live.js), all async:
//   view(id)                      -> on-chain invoice record or null
//   call({method,args,now})       -> verifier-signed contract call (attest_payment / attest_refund)
//   prepare(account, now)         -> { nonce, expires_at_ms, max_block_height } for the user to sign
//   submitDelegate(envelope, now) -> relayer submits the user's signed call, pays the gas
//   sponsorship(account, now)     -> sponsored-call accounting
//   recordSettlement(...)         -> demo only: a simulated USDC transfer receipt
import crypto from "node:crypto";
import { fakeTxHash } from "./ids.js";
import { canonical, HEX64 } from "../web/lib.js";
import { ChainError, RelayError } from "./errors.js";
import { sponsorship, recordSponsored } from "./sponsor.js";

export { ChainError };

const ID_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const SIM_GAS_FEE_NEAR = 0.00031; // simulated cost the relayer "pays" per call (demo only)
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Verify an ed25519 signature given the public key as hex. `message` is bytes or a string. */
export function verifyEd25519(publicKeyHex, message, signatureB64) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(publicKeyHex, "hex")]), format: "der", type: "spki" });
    return crypto.verify(null, Buffer.from(message), key, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

export class MockChain {
  constructor(store, config) {
    this.store = store;
    this.config = config;
    this.mode = "demo";
    if (!store.data.chain) store.data.chain = { height: 100000, invoices: {}, nonces: {}, txs: {} };
  }
  get s() { return this.store.data.chain; }

  async view(id) { return this.s.invoices[id] || null; }
  async getTx(hash) { return this.s.txs[hash] || null; }
  async sponsorship(account, now = Date.now()) { return sponsorship(this.store, account, now); }
  async ensureAccount() { return { created: false }; }

  async prepare(account, now = Date.now()) {
    return { nonce: Math.max(now, (this.s.nonces[account] || 0) + 1), expires_at_ms: now + 5 * 60 * 1000, max_block_height: 0 };
  }

  /** Verifier-signed call (the backend attesting a payment or refund). */
  async call({ method, args, now = Date.now() }) {
    return this._run({ predecessor: this.config.verifierId, signer: this.config.verifierId, method, args, relayed: false, now });
  }

  /**
   * envelope = { delegate: {sender, receiver, method, args, nonce, expires_at_ms}, signature(base64) }
   * The sender is an implicit NEAR account: its 64-hex account id IS its ed25519 public key.
   * Policy (receiver / method allowlist / daily cap) is enforced by relay.js before this runs.
   */
  async submitDelegate(envelope, now = Date.now()) {
    const d = envelope.delegate;
    if (!Number.isInteger(d.nonce) || d.nonce <= (this.s.nonces[d.sender] || 0)) throw new RelayError("Stale or replayed nonce", 409);
    if (!Number.isInteger(d.expires_at_ms) || d.expires_at_ms < now) throw new RelayError("Request expired", 408);
    if (d.expires_at_ms > now + this.config.relayMaxAgeMs) throw new RelayError("Expiry too far in the future");
    const signed = canonical({ sender: d.sender, receiver: d.receiver, method: d.method, args: d.args, nonce: d.nonce, expires_at_ms: d.expires_at_ms });
    if (!verifyEd25519(d.sender, signed, envelope.signature)) throw new RelayError("Bad signature", 401);
    try {
      const tx = this._run({
        predecessor: d.sender, signer: this.config.relayerAccount || "kobo-relayer.testnet",
        method: d.method, args: d.args || {}, relayed: true, nonce: d.nonce, now,
      });
      recordSponsored(this.store, d.sender, SIM_GAS_FEE_NEAR, now);
      return tx;
    } catch (e) {
      if (e instanceof ChainError) throw new RelayError(`Contract rejected the call: ${e.message}`, 422);
      throw e;
    }
  }

  _run({ predecessor, signer, method, args, relayed, nonce = null, now }) {
    const s = this.s;
    let error = null;
    try { this._execute(predecessor, method, args, now); }
    catch (e) { if (!(e instanceof ChainError)) throw e; error = e.message; }
    if (nonce !== null) s.nonces[predecessor] = nonce;
    s.height += 1;
    const hash = fakeTxHash(`${s.height}|${predecessor}|${method}|${JSON.stringify(args)}|${now}`);
    const tx = {
      hash, height: s.height, ts: now, signer, predecessor, receiver: this.config.contractId, method, args, relayed,
      outcome: error ? "Failure" : "SuccessValue", error, gas_paid_by: signer, sim_fee_near: relayed ? SIM_GAS_FEE_NEAR : null,
    };
    s.txs[hash] = tx;
    this.store.save();
    if (error) { const err = new ChainError(error); err.tx = tx; throw err; }
    return tx;
  }

  _execute(sender, method, a, now) {
    const s = this.s;
    switch (method) {
      case "create_invoice": {
        if (!ID_RE.test(a.id || "")) throw new ChainError("Bad invoice id");
        if (s.invoices[a.id]) throw new ChainError("Invoice id already exists");
        if (!/^[1-9]\d*$/.test(String(a.amount))) throw new ChainError("Amount must be a positive integer (USDC units)");
        if (!/^[0-9a-f]{64}$/.test(a.memo_hash || "")) throw new ChainError("memo_hash must be sha256 hex");
        if (!Number.isInteger(a.due_ms) || a.due_ms <= 0) throw new ChainError("Bad due date");
        s.invoices[a.id] = {
          owner: sender, amount: String(a.amount), due_ms: a.due_ms, memo_hash: a.memo_hash,
          status: "Open", created_ms: now, paid_ms: null, source_tx: null, refunds: 0, last_refund_tx: null,
        };
        return;
      }
      case "cancel_invoice": {
        const inv = this._need(a.id);
        if (inv.owner !== sender) throw new ChainError("Only the invoice owner can cancel");
        if (inv.status !== "Open") throw new ChainError(`Cannot cancel a ${inv.status} invoice`);
        inv.status = "Cancelled";
        return;
      }
      case "attest_payment": {
        this._verifierOnly(sender);
        const inv = this._need(a.id);
        if (inv.status === "Paid") throw new ChainError("Invoice already paid");
        if (inv.status !== "Open") throw new ChainError(`Cannot pay a ${inv.status} invoice`);
        if (BigInt(a.received) < BigInt(inv.amount)) throw new ChainError("Received amount is below the invoice amount");
        inv.status = "Paid";
        inv.paid_ms = now;
        inv.source_tx = a.source_tx || null;
        return;
      }
      case "attest_refund": {
        this._verifierOnly(sender);
        const inv = this._need(a.id);
        if (inv.status !== "Open") throw new ChainError(`Cannot refund a ${inv.status} invoice`);
        inv.refunds += 1;
        inv.last_refund_tx = a.refund_tx || null;
        return;
      }
      default:
        throw new ChainError(`Unknown method ${method}`);
    }
  }

  _need(id) {
    const inv = this.s.invoices[id];
    if (!inv) throw new ChainError("No such invoice");
    return inv;
  }
  _verifierOnly(sender) {
    if (sender !== this.config.verifierId) throw new ChainError("Only the verifier can attest");
  }

  /** Demo: simulate a client paying USDC directly on NEAR through ft_transfer_call (trustless path). */
  simulateDirectUsdcPayment(id, now = Date.now()) {
    const inv = this._need(id);
    if (inv.status !== "Open") throw new ChainError("Invoice is not open");
    inv.status = "Paid";
    inv.paid_ms = now;
    inv.source_tx = "ft_transfer_call from demo-client.near";
    this.store.save();
  }

  /** Demo: a simulated USDC transfer receipt (what NEAR Intents delivers on the NEAR side). */
  recordSettlement({ to, amount, from = "intents.near", now = Date.now() }) {
    const s = this.s;
    s.height += 1;
    const hash = fakeTxHash(`ft|${s.height}|${to}|${amount}|${now}`);
    s.txs[hash] = {
      hash, height: s.height, ts: now, signer: from, predecessor: from, receiver: "usdc.near (demo)",
      method: "ft_transfer", args: { receiver_id: to, amount: String(amount) }, relayed: false,
      outcome: "SuccessValue", error: null, gas_paid_by: from, sim_fee_near: null,
    };
    this.store.save();
    return s.txs[hash];
  }
}
