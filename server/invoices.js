import { canonical, fromUnits, invoiceTotal, memoPayload, dueMs, HEX64 } from "../web/lib.js";
import { sha256hex } from "./ids.js";
import { relay, RelayError } from "./relay.js";

export class ApiError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const str = (v, min, max, name) => {
  if (typeof v !== "string" || v.trim().length < min || v.length > max) throw new ApiError(`${name} must be ${min}-${max} characters`);
  return v.trim();
};

export class Invoices {
  constructor({ store, chain, intents, config }) {
    Object.assign(this, { store, chain, intents, config });
  }

  // ---- create -------------------------------------------------------------------------------
  /** details = human-readable invoice. envelope = freelancer-signed create_invoice call. */
  create(details, envelope, now = Date.now()) {
    const d = {
      client_name: str(details?.client_name, 1, 80, "client_name"),
      title: str(details?.title, 1, 120, "title"),
      note: details?.note ? str(details.note, 0, 500, "note") : "",
      due_date: details?.due_date,
      items: details?.items,
    };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.due_date || "") || Number.isNaN(dueMs(d.due_date))) throw new ApiError("due_date must be YYYY-MM-DD");
    if (!Array.isArray(d.items) || d.items.length < 1 || d.items.length > 20) throw new ApiError("1-20 line items required");
    d.items = d.items.map((i, n) => ({
      description: str(i?.description, 1, 140, `item ${n + 1} description`),
      qty: String(i?.qty),
      unit_price: String(i?.unit_price),
    }));
    let total;
    try { total = invoiceTotal(d.items); } catch (e) { throw new ApiError(e.message); }
    if (BigInt(total) <= 0n) throw new ApiError("Invoice total must be greater than zero");

    const call = envelope?.delegate;
    const owner = call?.sender;
    if (!HEX64.test(owner || "")) throw new ApiError("Missing or invalid sender account");
    const args = call.args || {};
    const id = args.id;
    // The signed on-chain call must commit to exactly these details.
    const memo_hash = sha256hex(canonical(memoPayload({ ...d, id, owner })));
    if (args.memo_hash !== memo_hash) throw new ApiError("Signed memo_hash does not match the invoice details");
    if (String(args.amount) !== total) throw new ApiError("Signed amount does not match the line items");
    if (args.due_ms !== dueMs(d.due_date)) throw new ApiError("Signed due date does not match");
    if (call.method !== "create_invoice") throw new ApiError("Envelope must be a create_invoice call");
    if (this.store.getInvoice(id)) throw new ApiError("Invoice id already exists", 409);

    let tx;
    try { tx = relay(this.chain, this.config, envelope, now); }
    catch (e) { if (e instanceof RelayError) throw new ApiError(e.message, e.status); throw e; }

    const inv = {
      id, owner, ...d, total, currency: "USDC", due_ms: args.due_ms, memo_hash,
      status: "open", created_at: now, create_tx: tx.hash, attempts: [],
      events: [{ at: now, type: "created", text: "Invoice created and recorded on NEAR. Gas paid by the Kobo relayer.", tx: tx.hash }],
    };
    return this.store.putInvoice(inv);
  }

  // ---- pay: get a deposit address from NEAR Intents -----------------------------------------
  async quote(id, { originAsset, refundTo }, now = Date.now()) {
    const inv = this._need(id);
    if (!["open", "refunded"].includes(inv.status)) throw new ApiError(`This invoice is ${inv.status}; it cannot be paid right now`, 409);
    if (typeof originAsset !== "string" || !originAsset) throw new ApiError("originAsset required");
    refundTo = str(refundTo, 6, 128, "refundTo");
    if (/\s/.test(refundTo)) throw new ApiError("refundTo must be a single wallet address");

    const common = { originAsset, amountOutUnits: inv.total, recipient: inv.owner, refundTo, invoiceId: id };
    const deadline = new Date(now + 30 * 60 * 1000).toISOString();
    await this.intents.quote({ ...common, deadline, dry: true }); // preview first; only commit on confirm
    const res = await this.intents.quote({ ...common, deadline, dry: false });
    const q = res.quote;
    if (!q?.depositAddress) throw new ApiError("Quote did not return a deposit address", 502);

    const tokens = await this.intents.listTokens();
    const tok = tokens.find((t) => t.assetId === originAsset) || {};
    const attempt = {
      created_at: now, origin_asset: originAsset, origin_symbol: tok.symbol || "?", origin_chain: tok.blockchain || "?",
      refund_to: refundTo, deposit_address: q.depositAddress, deposit_memo: q.depositMemo || null,
      amount_in: q.amountIn, amount_in_formatted: q.amountInFormatted, amount_in_usd: q.amountInUsd,
      amount_out: q.amountOut, deadline: q.deadline || deadline, intents_status: "PENDING_DEPOSIT",
      origin_tx: null, settle_tx: null, refund_tx: null,
    };
    inv.attempts.push(attempt);
    const CHAINS = { eth: "Ethereum", arb: "Arbitrum", base: "Base", sol: "Solana", btc: "Bitcoin", near: "NEAR" };
    const chainLabel = CHAINS[attempt.origin_chain] || attempt.origin_chain.toUpperCase();
    inv.events.push({ at: now, type: "quote", text: `Payment details issued: send ${q.amountInFormatted} ${attempt.origin_symbol} on ${chainLabel}.` });
    this.store.putInvoice(inv);
    return attempt;
  }

  // ---- status: pull from Intents, then write the result to the contract ----------------------
  async refresh(id, now = Date.now()) {
    const inv = this._need(id);
    const att = inv.attempts[inv.attempts.length - 1];
    if (!att || !["open", "pending"].includes(inv.status) || att.finalised) return inv;

    const st = await this.intents.status(att.deposit_address, now);
    const sd = st.swapDetails || {};
    att.intents_status = st.status;
    const originTx = sd.originChainTxHashes?.[0];
    if (originTx && !att.origin_tx) att.origin_tx = originTx;

    if (st.status === "PROCESSING" || st.status === "KNOWN_DEPOSIT_TX") {
      if (inv.status !== "pending") {
        inv.status = "pending";
        inv.events.push({ at: now, type: "deposit", text: "Deposit detected. NEAR Intents is converting it to USDC." });
      }
    } else if (st.status === "INCOMPLETE_DEPOSIT") {
      if (!att.warned) { att.warned = true; inv.events.push({ at: now, type: "warning", text: "Deposit received but below the required amount. Send the remainder or it will be refunded." }); }
    } else if (st.status === "SUCCESS") {
      let settle = sd.destinationChainTxHashes?.[0]?.hash;
      if (!settle && this.intents.mode === "demo") settle = this.chain.recordSettlement({ to: inv.owner, amount: inv.total, now }).hash;
      if (sd.amountOut && BigInt(sd.amountOut) < BigInt(inv.total)) throw new ApiError("Intents delivered less than the invoice amount; not marking paid", 502);
      const tx = this.chain.call({
        predecessor: this.config.verifierId, method: "attest_payment",
        args: { id, received: inv.total, source_tx: settle || "" }, now,
      });
      att.settle_tx = settle || null;
      att.finalised = true;
      inv.status = "paid";
      inv.paid_at = now;
      inv.paid_tx = tx.hash;
      inv.events.push({ at: now, type: "paid", text: `Paid: ${fromUnits(inv.total)} USDC settled to the freelancer's account.`, tx: settle || tx.hash });
    } else if (st.status === "REFUNDED") {
      const refundTx = sd.refundedChainTxHashes?.[0]?.hash || sd.originChainTxHashes?.[0]?.hash || "";
      const tx = this.chain.call({
        predecessor: this.config.verifierId, method: "attest_refund", args: { id, refund_tx: refundTx }, now,
      });
      att.refund_tx = refundTx || null;
      att.finalised = true;
      inv.status = "refunded";
      inv.events.push({ at: now, type: "refunded", text: "Payment was refunded to the client's wallet. The invoice is still unpaid.", tx: tx.hash });
    } else if (st.status === "FAILED") {
      att.finalised = true;
      inv.status = "open";
      inv.events.push({ at: now, type: "failed", text: "The swap failed. No funds were taken; try again." });
    }
    return this.store.putInvoice(inv);
  }

  cancel() { /* cancellation is a signed on-chain call; see POST /api/relay */ }

  // ---- views --------------------------------------------------------------------------------
  /** Safe for the public pay page. */
  publicView(inv, now = Date.now()) {
    const att = inv.attempts[inv.attempts.length - 1] || null;
    const onchain = this.chain.view(inv.id);
    return {
      id: inv.id, owner: inv.owner, client_name: inv.client_name, title: inv.title, note: inv.note,
      items: inv.items, total: inv.total, total_formatted: fromUnits(inv.total), currency: "USDC",
      due_date: inv.due_date, due_ms: inv.due_ms, created_at: inv.created_at,
      status: inv.status, overdue: !["paid", "cancelled"].includes(inv.status) && now > inv.due_ms,
      paid_at: inv.paid_at || null, create_tx: inv.create_tx, memo_hash: inv.memo_hash,
      hash_matches_chain: !!onchain && onchain.memo_hash === inv.memo_hash,
      onchain_status: onchain?.status || null,
      attempt: att && !att.finalised ? att : null,
      last_attempt: att,
      events: inv.events,
    };
  }

  _need(id) {
    const inv = this.store.getInvoice(id);
    if (!inv) throw new ApiError("Invoice not found", 404);
    return inv;
  }
}
