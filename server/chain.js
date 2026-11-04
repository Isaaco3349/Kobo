// Demo-mode ledger. It enforces exactly the same rules as contract/src/lib.rs, so the
// demo behaves like the real contract: ownership by predecessor, verifier-only attestations,
// no double payment, no paying less than the invoice amount.
import { fakeTxHash } from "./ids.js";

export class ChainError extends Error {}

const ID_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const SIM_GAS_FEE_NEAR = 0.00031; // simulated cost the relayer "pays" per call (demo only)

export class MockChain {
  constructor(store, config) {
    this.store = store;
    this.config = config;
    if (!store.data.chain) {
      store.data.chain = { height: 100000, invoices: {}, nonces: {}, txs: {}, sponsored: {} };
    }
  }
  get s() {
    return this.store.data.chain;
  }

  view(id) {
    return this.s.invoices[id] || null;
  }
  getTx(hash) {
    return this.s.txs[hash] || null;
  }
  lastNonce(sender) {
    return this.s.nonces[sender] || 0;
  }

  /** How many relayed calls this account has used today (UTC day) and how much gas was sponsored. */
  sponsorship(sender, now = Date.now()) {
    const day = new Date(now).toISOString().slice(0, 10);
    const rec = this.s.sponsored[sender] || { day, calls: 0, total_calls: 0, total_near: 0 };
    return { day, calls_today: rec.day === day ? rec.calls : 0, total_calls: rec.total_calls, total_near: rec.total_near };
  }

  /**
   * Execute a contract call. `predecessor` is who the contract sees (the freelancer for
   * relayed calls). `signer` is who paid gas (the relayer for relayed calls).
   */
  call({ predecessor, method, args, signer = predecessor, relayed = false, nonce = null, now = Date.now() }) {
    const c = this.config;
    const s = this.s;
    let error = null;
    try {
      this._execute(predecessor, method, args, now);
    } catch (e) {
      if (!(e instanceof ChainError)) throw e;
      error = e.message;
    }
    if (nonce !== null) s.nonces[predecessor] = nonce;
    s.height += 1;
    const hash = fakeTxHash(`${s.height}|${predecessor}|${method}|${JSON.stringify(args)}|${now}`);
    const tx = {
      hash,
      height: s.height,
      ts: now,
      signer,
      predecessor,
      receiver: c.contractId,
      method,
      args,
      relayed,
      outcome: error ? "Failure" : "SuccessValue",
      error,
      gas_paid_by: signer,
      sim_fee_near: relayed ? SIM_GAS_FEE_NEAR : null,
    };
    s.txs[hash] = tx;
    if (relayed) {
      const day = new Date(now).toISOString().slice(0, 10);
      const rec = s.sponsored[predecessor] || { day, calls: 0, total_calls: 0, total_near: 0 };
      if (rec.day !== day) {
        rec.day = day;
        rec.calls = 0;
      }
      rec.calls += 1;
      rec.total_calls += 1;
      rec.total_near = Number((rec.total_near + SIM_GAS_FEE_NEAR).toFixed(5));
      s.sponsored[predecessor] = rec;
    }
    this.store.save();
    if (error) {
      const err = new ChainError(error);
      err.tx = tx;
      throw err;
    }
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

  /** Record the USDC settlement transfer made by NEAR Intents (demo: a simulated ft_transfer receipt). */
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
