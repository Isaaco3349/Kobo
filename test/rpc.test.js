import test from "node:test";
import assert from "node:assert/strict";
import { Rpc, RpcError } from "../server/near-rpc.js";

const okBlock = { ok: true, status: 200, json: async () => ({ result: { header: { hash: "h", height: 7 } } }) };
const make = (fn) => { const calls = { n: 0 }; const rpc = new Rpc("http://x", async (...a) => { calls.n++; return fn(calls.n, ...a); }, { baseDelayMs: 1 }); return { rpc, calls }; };

test("reads retry dropped connections and then succeed", async () => {
  const { rpc, calls } = make((n) => { if (n < 3) throw new TypeError("fetch failed"); return okBlock; });
  assert.deepEqual(await rpc.finalBlock(), { hash: "h", height: 7 });
  assert.equal(calls.n, 3);
});

test("reads give up after the retries and report the failure", async () => {
  const { rpc, calls } = make(() => { throw new TypeError("fetch failed"); });
  await assert.rejects(() => rpc.finalBlock(), /fetch failed/);
  assert.equal(calls.n, 4); // 1 try + 3 retries
});

test("429 and 5xx are retried, a plain 4xx is not", async () => {
  let r = make((n) => (n < 2 ? { ok: false, status: 429 } : okBlock));
  assert.equal((await r.rpc.finalBlock()).height, 7);
  assert.equal(r.calls.n, 2);
  r = make(() => ({ ok: false, status: 400 }));
  await assert.rejects(() => r.rpc.finalBlock(), /NEAR RPC 400/);
  assert.equal(r.calls.n, 1);
});

test("a real RPC error is not retried", async () => {
  const { rpc, calls } = make(() => ({ ok: true, status: 200, json: async () => ({ error: { message: "bad", cause: { name: "INVALID_TRANSACTION" } } }) }));
  await assert.rejects(() => rpc.finalBlock(), RpcError);
  assert.equal(calls.n, 1);
});

test("send_tx is never re-sent automatically", async () => {
  const { rpc, calls } = make(() => { throw new TypeError("fetch failed"); });
  await assert.rejects(() => rpc.sendTx("AAAA"), /fetch failed/);
  assert.equal(calls.n, 1);
});

test("with several providers, a throttled one is skipped and the next one answers", async () => {
  const seen = [];
  const rpc = new Rpc("http://a, http://b", async (url) => { seen.push(url); return url === "http://a" ? { ok: false, status: 429 } : okBlock; }, { baseDelayMs: 1 });
  assert.equal((await rpc.finalBlock()).height, 7);
  assert.deepEqual(seen, ["http://a", "http://b"]);
});
