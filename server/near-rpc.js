// Minimal NEAR JSON-RPC client (fetch only).
export class RpcError extends Error {
  constructor(err) {
    super(err?.data && typeof err.data === "string" ? err.data : err?.message || "RPC error");
    this.name = "RpcError";
    this.cause_name = err?.cause?.name || "";
    this.raw = err;
  }
}

const b64 = (s) => Buffer.from(s).toString("base64");

const TRANSIENT_HTTP = new Set([429, 500, 502, 503, 504]);
const TRANSIENT_RPC = new Set(["INTERNAL_ERROR", "TIMEOUT_ERROR"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isNetworkError = (e) =>
  ["TypeError", "TimeoutError", "AbortError"].includes(e?.name) || /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|timeout|aborted/i.test(`${e?.message} ${e?.cause?.code || ""}`);

export class Rpc {
  /** Public RPC nodes are rate limited and flaky: every call has a timeout, and reads are retried
   *  with backoff. A transaction (send_tx) is NEVER blindly re-sent; the caller looks it up by hash. */
  constructor(url, fetchImpl = fetch, { timeoutMs = 20000, retries = 3, baseDelayMs = 400 } = {}) {
    // `url` may be a comma-separated list: attempts rotate through it, so one throttled provider does not block us.
    this.urls = String(url).split(",").map((u) => u.trim()).filter(Boolean);
    this.url = this.urls[0];
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.baseDelayMs = baseDelayMs;
  }

  async call(method, params) {
    const retryable = method !== "send_tx" && method !== "broadcast_tx_commit";
    const attempts = retryable ? this.retries + 1 : 1;
    let last;
    for (let i = 0; i < attempts; i++) {
      if (i) await sleep(this.baseDelayMs * 2 ** (i - 1) + Math.random() * 100);
      const url = this.urls[i % this.urls.length];
      try {
        const res = await this.fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: "kobo", method, params }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!res.ok) {
          last = new Error(`NEAR RPC ${res.status} from ${url}`);
          if (TRANSIENT_HTTP.has(res.status)) continue;
          throw last;
        }
        const j = await res.json();
        if (j.error) {
          const e = new RpcError(j.error);
          if (retryable && TRANSIENT_RPC.has(e.cause_name)) { last = e; continue; }
          throw e;
        }
        return j.result;
      } catch (e) {
        if (e instanceof RpcError || !retryable || !isNetworkError(e)) throw e;
        last = e;
      }
    }
    throw last;
  }

  async finalBlock() {
    const r = await this.call("block", { finality: "final" });
    return { hash: r.header.hash, height: r.header.height };
  }

  async viewFunction(account, method, args = {}) {
    const r = await this.call("query", {
      request_type: "call_function", finality: "optimistic", account_id: account, method_name: method,
      args_base64: b64(JSON.stringify(args)),
    });
    const text = Buffer.from(r.result).toString("utf8");
    return text ? JSON.parse(text) : null;
  }

  /** null when the account does not exist. */
  async viewAccount(account) {
    try {
      return await this.call("query", { request_type: "view_account", finality: "optimistic", account_id: account });
    } catch (e) {
      if (e instanceof RpcError && (e.cause_name === "UNKNOWN_ACCOUNT" || /does not exist/i.test(e.message))) return null;
      throw e;
    }
  }

  /** nonce of an access key, or null if the key does not exist. */
  async accessKeyNonce(account, publicKeyStr) {
    try {
      const r = await this.call("query", { request_type: "view_access_key", finality: "optimistic", account_id: account, public_key: publicKeyStr });
      return BigInt(r.nonce);
    } catch (e) {
      if (e instanceof RpcError && (/UNKNOWN_ACCESS_KEY|UNKNOWN_ACCOUNT/.test(e.cause_name) || /does not exist/i.test(e.message))) return null;
      throw e;
    }
  }

  sendTx(signedTxBase64, waitUntil = "EXECUTED") {
    return this.call("send_tx", { signed_tx_base64: signedTxBase64, wait_until: waitUntil });
  }
}

/** Walk a FinalExecutionOutcome; return a human-readable failure or null if everything succeeded. */
export function outcomeFailure(result) {
  const outcomes = [result.transaction_outcome, ...(result.receipts_outcome || [])];
  for (const o of outcomes) {
    const st = o?.outcome?.status;
    if (st && typeof st === "object" && st.Failure) {
      const s = JSON.stringify(st.Failure);
      const m = s.match(/Smart contract panicked: ([^"\\]*)/);
      return m ? m[1].trim() : s.slice(0, 300);
    }
  }
  if (result.status && typeof result.status === "object" && result.status.Failure) return JSON.stringify(result.status.Failure).slice(0, 300);
  return null;
}

/** Total NEAR burned by a transaction (fees), as a number. */
export function feeNear(result) {
  let y = 0n;
  for (const o of [result.transaction_outcome, ...(result.receipts_outcome || [])]) y += BigInt(o?.outcome?.tokens_burnt || 0);
  return Number(y) / 1e24;
}
