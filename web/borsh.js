// Minimal borsh + NEAR transaction encoding. Pure JS (Uint8Array, BigInt), no dependencies, so the
// SAME code runs in the browser (user signs a NEP-366 delegate action) and on the server
// (relayer wraps it in a transaction; verifier signs its own calls).
// Checked byte-for-byte against @near-js/transactions in test/borsh.test.js.

const te = new TextEncoder();

export const DELEGATE_PREFIX = 1073742190; // 2^30 + 366 (NEP-461 prefix for NEP-366)
export const GAS_30T = 30n * 10n ** 12n;
export const GAS_100T = 100n * 10n ** 12n;

const ACTION = { FunctionCall: 2, Transfer: 3, SignedDelegate: 8 };

class Writer {
  constructor() { this.parts = []; }
  raw(bytes) { this.parts.push(bytes); return this; }
  u8(n) { return this.raw(Uint8Array.of(n)); }
  u32(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return this.raw(b); }
  u64(n) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return this.raw(b); }
  u128(n) {
    let v = BigInt(n);
    const b = new Uint8Array(16);
    for (let i = 0; i < 16; i++) { b[i] = Number(v & 0xffn); v >>= 8n; }
    return this.raw(b);
  }
  bytes(b) { this.u32(b.length); return this.raw(b); }
  str(s) { return this.bytes(te.encode(s)); }
  publicKey(pk32) { this.u8(0); return this.raw(pk32); } // 0 = ed25519
  done() {
    const len = this.parts.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

function writeAction(w, a) {
  switch (a.type) {
    case "FunctionCall":
      w.u8(ACTION.FunctionCall).str(a.method).bytes(a.args).u64(a.gas).u128(a.deposit);
      break;
    case "Transfer":
      w.u8(ACTION.Transfer).u128(a.deposit);
      break;
    case "SignedDelegate":
      w.u8(ACTION.SignedDelegate).raw(a.bytes);
      break;
    default:
      throw new Error(`Unsupported action ${a.type}`);
  }
}

/** d = { sender, receiver, method, args (Uint8Array), gas, nonce, maxBlockHeight, publicKey (32 bytes) } */
export function encodeDelegateAction(d) {
  const w = new Writer().str(d.sender).str(d.receiver).u32(1);
  writeAction(w, { type: "FunctionCall", method: d.method, args: d.args, gas: d.gas, deposit: 0n });
  return w.u64(d.nonce).u64(d.maxBlockHeight).publicKey(d.publicKey).done();
}

/** The bytes the user's key signs (after sha256): NEP-461 prefix + borsh(DelegateAction). */
export function delegateSigningPayload(d) {
  return new Writer().u32(DELEGATE_PREFIX).raw(encodeDelegateAction(d)).done();
}

export function encodeSignedDelegate(d, signature64) {
  return new Writer().raw(encodeDelegateAction(d)).u8(0).raw(signature64).done();
}

/** tx = { signer, publicKey (32), nonce, receiver, blockHash (32), actions[] } */
export function encodeTransaction(tx) {
  const w = new Writer().str(tx.signer).publicKey(tx.publicKey).u64(tx.nonce).str(tx.receiver).raw(tx.blockHash).u32(tx.actions.length);
  tx.actions.forEach((a) => writeAction(w, a));
  return w.done();
}

export function encodeSignedTransaction(txBytes, signature64) {
  return new Writer().raw(txBytes).u8(0).raw(signature64).done();
}

// ---- small byte helpers (browser + node) -------------------------------------------------------
export const hexToBytes = (hex) => Uint8Array.from(hex.match(/../g).map((h) => parseInt(h, 16)));
export const bytesToHex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
export const utf8 = (s) => te.encode(s);
export function toBase64(bytes) { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); }
export function fromBase64(b64) { return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); }

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = "1" + out; else break; }
  return out;
}
export function b58decode(str) {
  let n = 0n;
  for (const c of str) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("Invalid base58");
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  let zeros = 0;
  for (const c of str) { if (c === "1") zeros++; else break; }
  return Uint8Array.from([...new Array(zeros).fill(0), ...bytes]);
}

/** 1 NEAR = 10^24 yocto. "0.001" -> 1000000000000000000000n */
export function nearToYocto(s) {
  const [w, f = ""] = String(s).split(".");
  return BigInt(w) * 10n ** 24n + BigInt(f.padEnd(24, "0").slice(0, 24) || "0");
}
