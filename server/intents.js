// NEAR Intents (1Click API) adapters.
//   MockIntents - deterministic local stand-in used in demo mode and tests. Same shapes as 1Click.
//   LiveIntents - thin client for https://1click.chaindefuser.com (docs: docs.near-intents.org).
import { sha256, base58 } from "./ids.js";

// ---------------------------------------------------------------------------------------------
// Demo token list (live mode fetches the real one from GET /v0/tokens).
export const DEMO_TOKENS = [
  { assetId: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near", symbol: "USDC", blockchain: "eth", decimals: 6, price: 1.0 },
  { assetId: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", symbol: "USDC", blockchain: "arb", decimals: 6, price: 1.0 },
  { assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", symbol: "USDC", blockchain: "base", decimals: 6, price: 1.0 },
  { assetId: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", symbol: "USDC", blockchain: "sol", decimals: 6, price: 1.0 },
  { assetId: "nep141:eth.omft.near", symbol: "ETH", blockchain: "eth", decimals: 18, price: 3200 },
  { assetId: "nep141:sol.omft.near", symbol: "SOL", blockchain: "sol", decimals: 9, price: 165 },
  { assetId: "nep141:btc.omft.near", symbol: "BTC", blockchain: "btc", decimals: 8, price: 68000 },
  { assetId: "nep141:wrap.near", symbol: "NEAR", blockchain: "near", decimals: 24, price: 4.2 },
];
export const DEMO_USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const DEMO_FEE_BPS = 20; // 0.2% simulated market-maker spread

function addressFor(chain, seed) {
  const h = sha256(seed);
  switch (chain) {
    case "eth": case "arb": case "base": return "0x" + h.subarray(0, 20).toString("hex");
    case "sol": return base58(h);
    case "btc": return "bc1q" + h.toString("hex").slice(0, 38);
    default: return h.toString("hex");
  }
}

export class MockIntents {
  constructor(store, { processingMs = 1500 } = {}) {
    this.store = store;
    this.processingMs = processingMs;
    this.mode = "demo";
    if (!store.data.intents) store.data.intents = { deposits: {} };
  }
  get deposits() {
    return this.store.data.intents.deposits;
  }

  async listTokens() {
    return DEMO_TOKENS.map(({ price, ...t }) => ({ ...t, price }));
  }

  /** Invoice amounts are fixed in USDC, so we always quote EXACT_OUTPUT. */
  async quote({ originAsset, amountOutUnits, recipient, refundTo, deadline, dry, invoiceId }) {
    const tok = DEMO_TOKENS.find((t) => t.assetId === originAsset);
    if (!tok) throw new Error(`Unknown origin asset ${originAsset}`);
    const usdOut = Number(amountOutUnits) / 1e6;
    const sameAsset = tok.symbol === "USDC";
    const usdIn = sameAsset ? usdOut * (1 + DEMO_FEE_BPS / 10000) : usdOut * (1 + DEMO_FEE_BPS / 10000 + 0.001);
    const amountInUnits = BigInt(Math.ceil((usdIn / tok.price) * 10 ** Math.min(tok.decimals, 12))) * 10n ** BigInt(Math.max(tok.decimals - 12, 0));
    const quote = {
      amountIn: amountInUnits.toString(),
      amountInFormatted: (Number(amountInUnits) / 10 ** tok.decimals).toFixed(Math.min(tok.decimals, 8)),
      amountInUsd: usdIn.toFixed(2),
      minAmountIn: amountInUnits.toString(),
      amountOut: String(amountOutUnits),
      amountOutFormatted: usdOut.toFixed(2),
      amountOutUsd: usdOut.toFixed(2),
      timeEstimate: 20,
      origin: { symbol: tok.symbol, blockchain: tok.blockchain, decimals: tok.decimals },
    };
    if (!dry) {
      quote.depositAddress = addressFor(tok.blockchain, `${invoiceId}|${originAsset}|${refundTo}|${recipient}`);
      quote.deadline = deadline;
    }
    return { quote, quoteRequest: { dry, swapType: "EXACT_OUTPUT", originAsset, recipient, refundTo, deadline } };
  }

  /** The client "sends funds" (demo button, or `POST /api/demo/pay`). */
  simulateDeposit(depositAddress, { outcome = "success", amountOut, recipient, now = Date.now() }) {
    this.deposits[depositAddress] = { at: now, outcome, amountOut, recipient };
    this.store.save();
  }

  async submitDeposit() {
    return { ok: true };
  }

  async status(depositAddress, now = Date.now()) {
    const d = this.deposits[depositAddress];
    if (!d) return { status: "PENDING_DEPOSIT", swapDetails: {} };
    if (now - d.at < this.processingMs) return { status: "PROCESSING", swapDetails: {} };
    const originTx = { hash: base58(sha256(`origin|${depositAddress}|${d.at}`)), explorerUrl: "" };
    if (d.outcome === "refund") {
      return { status: "REFUNDED", swapDetails: { originChainTxHashes: [originTx], refundedAmount: "1" } };
    }
    return { status: "SUCCESS", swapDetails: { amountOut: d.amountOut, originChainTxHashes: [originTx], destinationChainTxHashes: [] } };
  }
}

// ---------------------------------------------------------------------------------------------
export class LiveIntents {
  constructor(config) {
    this.base = config.oneClickUrl.replace(/\/$/, "");
    this.jwt = config.oneClickJwt;
    this.mode = "live";
    this._tokens = null;
  }
  _headers() {
    const h = { "Content-Type": "application/json", Accept: "application/json" };
    if (this.jwt) h.Authorization = `Bearer ${this.jwt}`;
    return h;
  }
  async _json(res) {
    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    if (!res.ok) throw new Error(`1Click ${res.status}: ${body.message || text.slice(0, 200)}`);
    return body;
  }

  async listTokens() {
    if (!this._tokens) this._tokens = await this._json(await fetch(`${this.base}/v0/tokens`, { headers: this._headers() }));
    return this._tokens;
  }

  /** Find the USDC-on-NEAR asset id from the live token list rather than hard-coding it. */
  async usdcOnNear() {
    const t = (await this.listTokens()).find((x) => x.symbol === "USDC" && x.blockchain === "near");
    if (!t) throw new Error("USDC on NEAR not found in 1Click token list");
    return t.assetId;
  }

  async quote({ originAsset, amountOutUnits, recipient, refundTo, deadline, dry }) {
    const body = {
      dry: !!dry,
      depositMode: "SIMPLE",
      swapType: "EXACT_OUTPUT", // the freelancer must receive exactly the invoice amount
      slippageTolerance: 100,
      originAsset,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: await this.usdcOnNear(),
      amount: String(amountOutUnits),
      refundTo,
      refundType: "ORIGIN_CHAIN",
      // NEAR-side assets are no longer delivered straight to a NEAR account by 1Click ("pair not available"):
      // the swap pays into an account's balance inside intents.near, and KOBO then withdraws it (chain-live.js).
      recipient,
      recipientType: "INTENTS",
      deadline,
    };
    const res = await this._json(await fetch(`${this.base}/v0/quote`, { method: "POST", headers: this._headers(), body: JSON.stringify(body) }));
    return res;
  }

  async submitDeposit(txHash, depositAddress) {
    return this._json(await fetch(`${this.base}/v0/deposit/submit`, { method: "POST", headers: this._headers(), body: JSON.stringify({ txHash, depositAddress }) }));
  }

  async status(depositAddress) {
    const url = `${this.base}/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`;
    return this._json(await fetch(url, { headers: this._headers() }));
  }
}
