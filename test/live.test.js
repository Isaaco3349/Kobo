// Live-mode logic tested against a fake NEAR RPC that DECODES every transaction we send using the
// reference library, then checks what the relayer / verifier actually put on the wire.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { b58encode, bytesToHex, GAS_30T, nearToYocto } from "../web/borsh.js";
import { buildEnvelope } from "../web/sign.js";
import { canonical, memoPayload, dueMs, invoiceTotal } from "../web/lib.js";
import { sha256hex } from "../server/ids.js";
import { createApp } from "../server/app.js";
import { Store } from "../server/store.js";
import { LiveChain, parseKey } from "../server/chain-live.js";
import { MockIntents } from "../server/intents.js";
import { verifyEd25519 } from "../server/chain.js";
import { RelayError } from "../server/errors.js";
import { config as base } from "../server/config.js";
import { sampleDetails, newId } from "./helpers.js";

let T, ok = true;
try { T = await import("@near-js/transactions"); } catch { ok = false; }
const skip = !ok && "dev deps not installed";

const PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
function newKey() {
  const seed = crypto.randomBytes(32);
  const k = crypto.createPrivateKey({ key: Buffer.concat([PKCS8, seed]), format: "der", type: "pkcs8" });
  const pub = Buffer.from(crypto.createPublicKey(k).export({ format: "jwk" }).x, "base64url");
  return { str: "ed25519:" + b58encode(Buffer.concat([seed, pub])), pubHex: pub.toString("hex") };
}
const fail = (m) => ({ transaction: { hash: "FAILHASH" }, transaction_outcome: { outcome: { status: { SuccessReceiptId: "x" }, tokens_burnt: "0" } },
  receipts_outcome: [{ outcome: { status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${m}` } } } } }, tokens_burnt: "0" } }] });

class FakeRpc {
  constructor(keys) {
    this.keys = keys; // account -> pubkey hex, to verify the signatures we produce
    this.height = 5000;
    this.accounts = new Set(Object.keys(keys));
    this.nonce = {};
    this.registered = new Set();
    this.invoices = {};
    this.sent = [];
    this.failWith = null;
  }
  async finalBlock() { return { hash: b58encode(crypto.randomBytes(32)), height: this.height }; }
  async viewAccount(a) { return this.accounts.has(a) ? { amount: "0" } : null; }
  async accessKeyNonce(a) { return this.accounts.has(a) ? this.nonce[a] ?? 1000n * 1_000_000n : null; }
  async viewFunction(acc, method, args) {
    if (method === "storage_balance_of") return this.registered.has(args.account_id) ? { total: "1", available: "0" } : null;
    if (method === "storage_balance_bounds") return { min: "1250000000000000000000", max: null };
    if (method === "get_invoice") return this.invoices[args.id] || null;
    throw new Error(`unexpected view ${method}`);
  }
  async sendTx(b64) {
    const bytes = Buffer.from(b64, "base64");
    const stx = T.decodeSignedTransaction(bytes);
    const t = stx.transaction;
    const signer = t.signerId;
    const hash = crypto.createHash("sha256").update(bytes.subarray(0, bytes.length - 65)).digest();
    const sigOk = verifyEd25519(this.keys[signer], hash, bytes.subarray(bytes.length - 64).toString("base64"));
    const expectedNonce = (this.nonce[signer] ?? 1000n * 1_000_000n) + 1n;
    this.sent.push({ signer, receiver: t.receiverId, actions: t.actions, sigOk, nonceOk: t.nonce === expectedNonce });
    this.nonce[signer] = t.nonce;
    if (this.failWith) return fail(this.failWith);
    for (const a of t.actions) {
      if (a.transfer) this.accounts.add(t.receiverId);
      if (a.functionCall) this._call(t.receiverId, signer, a.functionCall);
      if (a.signedDelegate) {
        const da = a.signedDelegate.delegateAction;
        this._call(da.receiverId, da.senderId, da.actions[0].functionCall);
      }
    }
    return { transaction: { hash: "TX" + this.sent.length }, transaction_outcome: { outcome: { status: { SuccessReceiptId: "x" }, tokens_burnt: "300000000000000000000" } }, receipts_outcome: [{ outcome: { status: { SuccessValue: "" }, tokens_burnt: "1000000000000000000000" } }] };
  }
  _call(receiver, predecessor, fc) {
    const args = JSON.parse(Buffer.from(fc.args).toString());
    if (fc.methodName === "storage_deposit") this.registered.add(args.account_id);
    if (fc.methodName === "create_invoice") this.invoices[args.id] = { owner: predecessor, amount: args.amount, due_ms: args.due_ms, memo_hash: args.memo_hash, status: "Open", created_ms: 1, paid_ms: null, source_tx: null, refunds: 0, last_refund_tx: null };
    if (fc.methodName === "attest_payment") Object.assign(this.invoices[args.id], { status: "Paid", source_tx: args.source_tx });
  }
}

function setup() {
  const relayer = newKey(), verifier = newKey();
  const config = {
    ...base, mode: "live", dbPath: null, contractId: "kobo-invoices.testnet", relayerAccount: "kobo-relayer.testnet", verifierId: "kobo-verifier.testnet",
    relayerKey: relayer.str, verifierKey: verifier.str, usdcContract: "usdc.test", fundNear: "0.001", provisionPerIpHour: 1000,
  };
  const rpc = new FakeRpc({ "kobo-relayer.testnet": relayer.pubHex, "kobo-verifier.testnet": verifier.pubHex });
  const store = new Store(null);
  const chain = new LiveChain({ config, store, rpc });
  return { config, rpc, store, chain };
}

function freelancer() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const account = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("hex");
  return {
    account,
    signRaw: (bytes) => crypto.sign(null, Buffer.from(bytes), privateKey),
    envelope: (prep, method, args, receiver = "kobo-invoices.testnet") => buildEnvelope({
      mode: "live", sender: account, receiver, method, args, prep,
      sha256: async (b) => crypto.createHash("sha256").update(b).digest(),
      sign: async (m) => crypto.sign(null, Buffer.from(m), privateKey),
    }),
  };
}

const createArgs = (id, details, owner) => ({
  id, amount: invoiceTotal(details.items), due_ms: dueMs(details.due_date),
  memo_hash: sha256hex(canonical(memoPayload({ ...details, id, owner }))),
});

test("prepare sets up a brand-new account once: funded by the relayer, registered for USDC", { skip }, async () => {
  const { chain, rpc } = setup();
  const me = freelancer();
  const prep = await chain.prepare(me.account);
  assert.equal(prep.nonce, 1000 * 1_000_000 + 1);
  assert.ok(prep.max_block_height > rpc.height);
  assert.equal(rpc.sent.length, 2);
  const [fund, reg] = rpc.sent;
  assert.equal(fund.signer, "kobo-relayer.testnet");
  assert.equal(fund.receiver, me.account);
  assert.equal(fund.actions[0].transfer.deposit, nearToYocto("0.001"));
  assert.equal(reg.receiver, "usdc.test");
  assert.equal(reg.actions[0].functionCall.methodName, "storage_deposit");
  assert.equal(reg.actions[0].functionCall.deposit, 1250000000000000000000n);
  assert.deepEqual(JSON.parse(Buffer.from(reg.actions[0].functionCall.args).toString()), { account_id: me.account, registration_only: true });
  assert.ok(fund.sigOk && reg.sigOk && fund.nonceOk && reg.nonceOk, "relayer signatures and nonces are valid");

  await chain.prepare(me.account); // second time: nothing more to pay for
  assert.equal(rpc.sent.length, 2);
});

test("gasless create: browser-style envelope -> relayer wraps it -> exactly one capped delegate action", { skip }, async () => {
  const { config, rpc, store, chain } = setup();
  const app = createApp({ config, store, chain, intents: new MockIntents(store, { processingMs: 0 }) });
  await new Promise((r) => app.server.listen(0, r));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (p, body) => { const r = await fetch(url + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  try {
    const me = freelancer();
    const details = sampleDetails();
    const id = newId();
    const prep = await (await fetch(`${url}/api/prepare/${me.account}`)).json();
    const args = createArgs(id, details, me.account);
    const envelope = await me.envelope(prep, "create_invoice", args);
    const r = await post("/api/invoices", { details, envelope });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.hash_matches_chain, true);
    assert.equal(r.body.create_tx, "TX3"); // fund, register, then the relayed call

    const relayed = rpc.sent[2];
    assert.equal(relayed.signer, "kobo-relayer.testnet");
    assert.equal(relayed.receiver, me.account);
    assert.equal(relayed.actions.length, 1);
    assert.ok(relayed.sigOk && relayed.nonceOk);
    const da = relayed.actions[0].signedDelegate.delegateAction;
    assert.equal(da.senderId, me.account);
    assert.equal(da.receiverId, "kobo-invoices.testnet");
    assert.equal(da.actions.length, 1);
    const fc = da.actions[0].functionCall;
    assert.equal(fc.methodName, "create_invoice");
    assert.equal(fc.gas, GAS_30T);
    assert.equal(fc.deposit, 0n);
    assert.equal(canonical(JSON.parse(Buffer.from(fc.args).toString())), canonical(args));
    assert.equal(rpc.invoices[id].owner, me.account, "contract sees the freelancer, not the relayer");

    // pay through the (mock) Intents, verifier attests on-chain
    const q = await post(`/api/invoices/${id}/quote`, { originAsset: "nep141:eth.omft.near", refundTo: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D" });
    assert.equal(q.status, 200, JSON.stringify(q.body));
    app.intents.simulateDeposit(q.body.deposit_address, { outcome: "success", amountOut: invoiceTotal(details.items), recipient: me.account });
    const v = await (await fetch(`${url}/api/invoices/${id}`)).json();
    assert.equal(v.status, "paid");
    assert.equal(v.onchain_status, "Paid");
    const attest = rpc.sent[rpc.sent.length - 1];
    assert.equal(attest.signer, "kobo-verifier.testnet");
    assert.equal(attest.receiver, "kobo-invoices.testnet");
    assert.ok(attest.sigOk && attest.nonceOk);
    assert.equal(attest.actions[0].functionCall.methodName, "attest_payment");
  } finally { await new Promise((r) => app.server.close(r)); }
});

test("relayer refuses forged, expired, extra-gas and non-sponsored calls", { skip }, async () => {
  const { config, rpc, store, chain } = setup();
  const app = createApp({ config, store, chain, intents: new MockIntents(store, { processingMs: 0 }) });
  await new Promise((r) => app.server.listen(0, r));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (envelope, details = sampleDetails()) => { const r = await fetch(url + "/api/invoices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ details, envelope }) }); return r.status; };
  try {
    const me = freelancer(), mallory = freelancer();
    const details = sampleDetails();
    const prep = await (await fetch(`${url}/api/prepare/${me.account}`)).json();
    const before = rpc.sent.length;

    // signed by a different key
    let id = newId();
    let env = await mallory.envelope(prep, "create_invoice", createArgs(id, details, me.account));
    env.delegate.sender = me.account;
    assert.equal(await post(env), 401);

    // user signs a delegate action that asks for 300 Tgas; we always rebuild with our fixed 30 Tgas,
    // so that signature no longer matches and the relayer refuses (it can never be made to burn more)
    id = newId();
    const args = createArgs(id, details, me.account);
    const { delegateSigningPayload, utf8, hexToBytes, toBase64 } = await import("../web/borsh.js");
    const greedy = delegateSigningPayload({ sender: me.account, receiver: "kobo-invoices.testnet", method: "create_invoice", args: utf8(canonical(args)), gas: 300n * 10n ** 12n, nonce: BigInt(prep.nonce), maxBlockHeight: BigInt(prep.max_block_height), publicKey: hexToBytes(me.account) });
    env = { delegate: { sender: me.account, receiver: "kobo-invoices.testnet", method: "create_invoice", args, nonce: prep.nonce, max_block_height: prep.max_block_height }, signature: toBase64(me.signRaw(crypto.createHash("sha256").update(greedy).digest())) };
    assert.equal(await post(env), 401);

    // expired
    id = newId();
    env = await me.envelope({ ...prep, max_block_height: rpc.height - 1 }, "create_invoice", createArgs(id, details, me.account));
    assert.equal(await post(env), 408);

    // other contract / other method are never sponsored
    id = newId();
    env = await me.envelope(prep, "create_invoice", createArgs(id, details, me.account), "someone-else.testnet");
    assert.equal(await post(env), 403);
    env = await me.envelope(prep, "attest_payment", { id: "AAAA-BBBB", received: "1", source_tx: "" });
    const rr = await fetch(url + "/api/relay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(env) });
    assert.equal(rr.status, 403);

    assert.equal(rpc.sent.length, before, "nothing was submitted for any rejected request");
  } finally { await new Promise((r) => app.server.close(r)); }
});

test("a contract panic is reported, not swallowed", { skip }, async () => {
  const { chain, rpc } = setup();
  const me = freelancer();
  const prep = await chain.prepare(me.account);
  const env = await me.envelope(prep, "cancel_invoice", { id: "AAAA-BBBB" });
  rpc.failWith = "Only the invoice owner can cancel";
  await assert.rejects(() => chain.submitDelegate(env), (e) => e instanceof RelayError && e.status === 422 && /Only the invoice owner/.test(e.message));
  await assert.rejects(() => chain.call({ method: "attest_payment", args: { id: "AAAA-BBBB", received: "1", source_tx: "" } }), /Only the invoice owner/);
});

test("parseKey accepts 64-byte and 32-byte keys, rejects mismatches", () => {
  const k = newKey();
  assert.equal(parseKey(k.str).pubStr, "ed25519:" + b58encode(Buffer.from(k.pubHex, "hex")));
  assert.throws(() => parseKey("rsa:abc"));
  const other = newKey();
  const seedOnly = "ed25519:" + b58encode(Buffer.from(b58decodeSeed(k.str)));
  assert.equal(parseKey(seedOnly).pubStr, parseKey(k.str).pubStr);
  assert.throws(() => parseKey("ed25519:" + b58encode(Buffer.concat([Buffer.from(b58decodeSeed(k.str)), Buffer.from(other.pubHex, "hex")]))), /does not match/);
});

import { b58decode } from "../web/borsh.js";
const b58decodeSeed = (s) => b58decode(s.slice(8)).slice(0, 32);
