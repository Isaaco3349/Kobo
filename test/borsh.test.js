// Parity: our zero-dependency encoder must produce the exact bytes the reference NEAR libraries do.
// Skipped automatically if the dev dependencies are not installed (npm install).
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { encodeDelegateAction, delegateSigningPayload, encodeSignedDelegate, encodeTransaction, encodeSignedTransaction, b58encode, b58decode, utf8, bytesToHex, nearToYocto, GAS_30T } from "../web/borsh.js";

let T, C, ok = true;
try {
  T = await import("@near-js/transactions");
  C = await import("@near-js/crypto");
} catch { ok = false; }

const pk32 = crypto.randomBytes(32);
const sk = (n) => Uint8Array.from(crypto.randomBytes(n));
const pkStr = (b) => "ed25519:" + b58encode(b);

test("base58 round-trips, including leading zero bytes", () => {
  for (const b of [Uint8Array.of(0, 0, 1, 2, 3), crypto.randomBytes(32), Uint8Array.of(255)]) {
    assert.deepEqual(b58decode(b58encode(b)), Uint8Array.from(b));
  }
});

test("nearToYocto", () => {
  assert.equal(nearToYocto("1"), 10n ** 24n);
  assert.equal(nearToYocto("0.001"), 10n ** 21n);
  assert.equal(nearToYocto("0.00125"), 1250n * 10n ** 18n);
});

test("DelegateAction + SignedDelegate bytes match @near-js/transactions", { skip: !ok && "dev deps not installed" }, () => {
  const args = utf8('{"id":"K7QM-2XPD","amount":"850000000"}');
  const sender = bytesToHex(pk32);
  const d = { sender, receiver: "kobo-invoices.testnet", method: "create_invoice", args, gas: GAS_30T, nonce: 123456789012n, maxBlockHeight: 987654321n, publicKey: pk32 };

  const lib = T.buildDelegateAction({
    senderId: sender, receiverId: d.receiver,
    actions: [T.actionCreators.functionCall(d.method, args, GAS_30T, 0n)],
    nonce: d.nonce, maxBlockHeight: d.maxBlockHeight, publicKey: C.PublicKey.fromString(pkStr(pk32)),
  });
  const libBytes = T.encodeDelegateAction(lib);
  // The library's encodeDelegateAction prepends the NEP-461 prefix; ours splits payload vs body.
  assert.equal(bytesToHex(delegateSigningPayload(d)), bytesToHex(libBytes));
  assert.equal(bytesToHex(delegateSigningPayload(d).slice(4)), bytesToHex(encodeDelegateAction(d)));

  const sig = sk(64);
  const libSigned = T.encodeSignedDelegate(new T.SignedDelegate({ delegateAction: lib, signature: new T.Signature({ keyType: 0, data: sig }) }));
  assert.equal(bytesToHex(encodeSignedDelegate(d, sig)), bytesToHex(libSigned));
});

test("Transaction (FunctionCall, Transfer, SignedDelegate) bytes match @near-js/transactions", { skip: !ok && "dev deps not installed" }, () => {
  const blockHash = sk(32);
  const signerPk = sk(32);
  const common = { signer: "kobo-relayer.testnet", publicKey: signerPk, nonce: 55n, receiver: "kobo-invoices.testnet", blockHash };

  const libActions = [
    T.actionCreators.functionCall("attest_payment", utf8('{"id":"AAAA-BBBB"}'), GAS_30T, 0n),
    T.actionCreators.transfer(nearToYocto("0.001")),
  ];
  const libTx = T.createTransaction(common.signer, C.PublicKey.fromString(pkStr(signerPk)), common.receiver, common.nonce, libActions, blockHash);
  const ours = encodeTransaction({
    ...common,
    actions: [
      { type: "FunctionCall", method: "attest_payment", args: utf8('{"id":"AAAA-BBBB"}'), gas: GAS_30T, deposit: 0n },
      { type: "Transfer", deposit: nearToYocto("0.001") },
    ],
  });
  assert.equal(bytesToHex(ours), bytesToHex(T.encodeTransaction(libTx)));

  const sig = sk(64);
  const libSigned = new T.SignedTransaction({ transaction: libTx, signature: new T.Signature({ keyType: 0, data: sig }) });
  assert.equal(bytesToHex(encodeSignedTransaction(ours, sig)), bytesToHex(libSigned.encode()));

  // relayer wrapping a user's signed delegate action
  const sender = bytesToHex(pk32);
  const args = utf8("{}");
  const d = { sender, receiver: common.receiver, method: "cancel_invoice", args, gas: GAS_30T, nonce: 7n, maxBlockHeight: 99n, publicKey: pk32 };
  const lib = T.buildDelegateAction({ senderId: sender, receiverId: d.receiver, actions: [T.actionCreators.functionCall(d.method, args, GAS_30T, 0n)], nonce: 7n, maxBlockHeight: 99n, publicKey: C.PublicKey.fromString(pkStr(pk32)) });
  const signedDelegate = new T.SignedDelegate({ delegateAction: lib, signature: new T.Signature({ keyType: 0, data: sig }) });
  const libWrapped = T.createTransaction(common.signer, C.PublicKey.fromString(pkStr(signerPk)), sender, common.nonce, [T.actionCreators.signedDelegate(signedDelegate)], blockHash);
  const oursWrapped = encodeTransaction({ ...common, receiver: sender, actions: [{ type: "SignedDelegate", bytes: encodeSignedDelegate(d, sig) }] });
  assert.equal(bytesToHex(oursWrapped), bytesToHex(T.encodeTransaction(libWrapped)));
});
