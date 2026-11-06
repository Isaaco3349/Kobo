import test from "node:test";
import assert from "node:assert/strict";
import { makeIdentity, sampleDetails, createEnvelope, newId, startApp } from "./helpers.js";
import { fromUnits } from "../web/lib.js";

const USDC_ARB = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
const ETH = "nep141:eth.omft.near";

async function makeInvoice(app, ident) {
  const id = newId();
  const details = sampleDetails();
  const r = await app.api("/api/invoices", { method: "POST", body: { details, envelope: createEnvelope(id, details, ident) } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { id, details, view: r.body };
}

test("paid-invoice flow: create (gasless) -> quote -> pay from another chain -> paid with receipts", async () => {
  const app = await startApp();
  try {
    const me = makeIdentity();
    const { id, view } = await makeInvoice(app, me);
    assert.equal(view.total_formatted, "850.00");
    assert.equal(view.status, "open");
    assert.equal(view.hash_matches_chain, true, "off-chain details must match the on-chain memo hash");

    // the freelancer never paid gas: the relayer did
    const create = (await app.api(`/api/tx/${view.create_tx}`)).body;
    assert.equal(create.predecessor, me.account);
    assert.notEqual(create.signer, me.account);
    assert.equal(create.relayed, true);

    // client picks ETH on Arbitrum-less path: native ETH
    const q = await app.api(`/api/invoices/${id}/quote`, { method: "POST", body: { originAsset: ETH, refundTo: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D" } });
    assert.equal(q.status, 200, JSON.stringify(q.body));
    assert.ok(q.body.deposit_address.startsWith("0x"));
    assert.ok(Number(q.body.amount_in_usd) > 850, "client pays a small conversion cost on top");

    let s = await app.api(`/api/invoices/${id}`);
    assert.equal(s.body.status, "open", "nothing paid yet");

    await app.api(`/api/demo/pay/${id}`, { method: "POST", body: {} });
    s = await app.api(`/api/invoices/${id}`);
    assert.equal(s.body.status, "paid");
    assert.equal(s.body.onchain_status, "Paid");
    const settle = s.body.events.find((e) => e.type === "paid").tx;
    const settleTx = await app.api(`/api/tx/${settle}`);
    assert.equal(settleTx.body.args.receiver_id, me.account);
    assert.equal(fromUnits(settleTx.body.args.amount), "850.00");

    // paying twice is not possible
    const again = await app.api(`/api/invoices/${id}/quote`, { method: "POST", body: { originAsset: ETH, refundTo: "0xabc123" } });
    assert.equal(again.status, 409);

    // accountant CSV
    const csv = (await app.api(`/api/owners/${me.account}/export.csv`)).body;
    assert.ok(csv.includes(id));
    assert.ok(csv.includes("Paid"));
    assert.ok(csv.includes("850.00"));
    assert.ok(csv.includes("ETH on ETH"));
  } finally { await app.close(); }
});

test("refund flow: invoice stays unpaid, refund is recorded, client can try again", async () => {
  const app = await startApp();
  try {
    const me = makeIdentity();
    const { id } = await makeInvoice(app, me);
    await app.api(`/api/invoices/${id}/quote`, { method: "POST", body: { originAsset: USDC_ARB, refundTo: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D" } });
    await app.api(`/api/demo/pay/${id}`, { method: "POST", body: { outcome: "refund" } });
    const s = await app.api(`/api/invoices/${id}`);
    assert.equal(s.body.status, "refunded");
    assert.equal(s.body.onchain_status, "Open");
    const retry = await app.api(`/api/invoices/${id}/quote`, { method: "POST", body: { originAsset: USDC_ARB, refundTo: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D" } });
    assert.equal(retry.status, 200);
  } finally { await app.close(); }
});

test("relayer only pays for allowlisted calls to our contract, with valid fresh signatures", async () => {
  const app = await startApp();
  try {
    const me = makeIdentity();
    const details = sampleDetails();
    const post = (envelope) => app.api("/api/invoices", { method: "POST", body: { details, envelope } });

    // wrong contract
    let id = newId();
    let env = createEnvelope(id, details, me, {});
    env = me.sign("create_invoice", env.delegate.args, { receiver: "someone-elses.testnet" });
    assert.equal((await post(env)).status, 403);

    // tampered after signing
    id = newId();
    env = createEnvelope(id, details, me);
    env.delegate.args.id = newId();
    assert.ok([400, 401].includes((await post(env)).status));

    // replay
    id = newId();
    env = createEnvelope(id, details, me);
    assert.equal((await post(env)).status, 201);
    const replayId = newId();
    const stale = me.sign("create_invoice", createEnvelope(replayId, details, me).delegate.args, { nonce: 1 });
    assert.equal((await post(stale)).status, 409);

    // expired
    id = newId();
    const exp = me.sign("create_invoice", createEnvelope(id, details, me).delegate.args, { expires_at_ms: Date.now() - 1000 });
    assert.equal((await post(exp)).status, 408);

    // details that do not match the signed hash
    id = newId();
    env = createEnvelope(id, details, me);
    const forged = { ...details, client_name: "Someone Else" };
    assert.equal((await app.api("/api/invoices", { method: "POST", body: { details: forged, envelope: env } })).status, 400);

    // a user cannot sponsor-call verifier-only methods
    const r = await app.api("/api/relay", { method: "POST", body: me.sign("attest_payment", { id: "AAAA-BBBB", received: "1" }) });
    assert.equal(r.status, 403);
  } finally { await app.close(); }
});

test("only the owner can cancel; duplicate ids are rejected", async () => {
  const app = await startApp();
  try {
    const a = makeIdentity(), b = makeIdentity();
    const { id } = await makeInvoice(app, a);
    const bad = await app.api("/api/relay", { method: "POST", body: b.sign("cancel_invoice", { id }) });
    assert.equal(bad.status, 422);
    const ok = await app.api("/api/relay", { method: "POST", body: a.sign("cancel_invoice", { id }) });
    assert.equal(ok.status, 200);
    const s = await app.api(`/api/invoices/${id}`);
    assert.equal(s.body.onchain_status, "Cancelled");
  } finally { await app.close(); }
});

test("CSV neutralises spreadsheet formula injection", async () => {
  const { invoicesToCsv } = await import("../server/csv.js");
  const csv = invoicesToCsv([{ id: "AAAA-BBBB", created_at: 0, due_date: "2099-01-01", client_name: "=HYPERLINK(\"http://x\")", title: "t", items: [], total: "1000000", status: "open", attempts: [], note: "" }]);
  assert.ok(csv.includes("'=HYPERLINK"));
});

test("owner cancels with a signed gasless call; strangers cannot; cancelled invoices cannot be paid", async () => {
  const app = await startApp();
  try {
    const me = makeIdentity(), other = makeIdentity();
    const { id } = await makeInvoice(app, me);
    const bad = await app.api(`/api/invoices/${id}/cancel`, { method: "POST", body: { envelope: other.sign("cancel_invoice", { id }) } });
    assert.equal(bad.status, 403);
    const ok = await app.api(`/api/invoices/${id}/cancel`, { method: "POST", body: { envelope: me.sign("cancel_invoice", { id }) } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.status, "cancelled");
    assert.equal(ok.body.onchain_status, "Cancelled");
    const pay = await app.api(`/api/invoices/${id}/quote`, { method: "POST", body: { originAsset: ETH, refundTo: "0xabc123" } });
    assert.equal(pay.status, 409);
  } finally { await app.close(); }
});

test("trustless path: a direct USDC payment on NEAR is picked up from the contract and shown as paid", async () => {
  const app = await startApp();
  try {
    const me = makeIdentity();
    const { id } = await makeInvoice(app, me);
    app.chain.simulateDirectUsdcPayment(id); // what ft_on_transfer does on the real contract
    const s = await app.api(`/api/invoices/${id}`);
    assert.equal(s.body.status, "paid");
    assert.ok(s.body.events.some((e) => e.type === "paid" && e.direct));
    const again = await app.api(`/api/invoices/${id}/quote`, { method: "POST", body: { originAsset: ETH, refundTo: "0xabc123" } });
    assert.equal(again.status, 409);
  } finally { await app.close(); }
});

test("background poller settles a payment even if nobody opens the page", async () => {
  const app = await startApp();
  try {
    const me = makeIdentity();
    const { id } = await makeInvoice(app, me);
    const q = await app.api(`/api/invoices/${id}/quote`, { method: "POST", body: { originAsset: USDC_ARB, refundTo: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D" } });
    app.intents.simulateDeposit(q.body.deposit_address, { outcome: "success", amountOut: q.body.amount_out, recipient: me.account });
    assert.equal(await app.svc.pollPending(), 1);
    assert.equal(app.store.getInvoice(id).status, "paid");
    assert.equal(await app.svc.pollPending(), 0, "nothing left to poll");
  } finally { await app.close(); }
});

test("prepare hands out strictly increasing nonces", async () => {
  const app = await startApp();
  try {
    const me = makeIdentity();
    const p1 = await app.api(`/api/prepare/${me.account}`);
    assert.equal(p1.status, 200);
    await makeInvoice(app, me); // uses nonce 1.. from the test identity (small numbers)
    const p2 = await app.api(`/api/prepare/${me.account}`);
    assert.ok(p2.body.nonce >= p1.body.nonce);
    assert.ok(p2.body.expires_at_ms > Date.now());
  } finally { await app.close(); }
});

test("network trouble is a clear 503 with a reason, not a bare 'Internal error'", async () => {
  const { RpcError } = await import("../server/near-rpc.js");
  const acct = "a".repeat(64);
  for (const boom of [new TypeError("fetch failed"), new RpcError({ message: "node is syncing" })]) {
    const stub = { mode: "demo", prepare: async () => { throw boom; }, sponsorship: async () => ({}), view: async () => null };
    const app = await startApp({ chain: stub });
    try {
      const r = await app.api(`/api/prepare/${acct}`);
      assert.equal(r.status, 503);
      assert.match(r.body.error, /NEAR network did not respond properly/);
      assert.match(r.body.error, /try again/i);
    } finally { await app.close(); }
  }
});

test("a deposit made on another chain links to that chain's explorer, not NEAR's", async () => {
  const { originTxUrl } = await import("../server/invoices.js");
  assert.equal(originTxUrl("base", "0xabc"), "https://basescan.org/tx/0xabc");
  assert.equal(originTxUrl("arb", "0xabc"), "https://arbiscan.io/tx/0xabc");
  assert.equal(originTxUrl("sol", "5xyz"), "https://solscan.io/tx/5xyz");
  assert.equal(originTxUrl("unknown", "0xabc"), undefined);
  assert.equal(originTxUrl("base", undefined), undefined);
});
