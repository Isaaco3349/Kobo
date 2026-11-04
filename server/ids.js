import crypto from "node:crypto";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58(buf) {
  let n = BigInt("0x" + (Buffer.from(buf).toString("hex") || "0"));
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of buf) {
    if (b === 0) out = "1" + out;
    else break;
  }
  return out;
}

export const sha256 = (s) => crypto.createHash("sha256").update(s).digest();
export const sha256hex = (s) => sha256(s).toString("hex");

/** Short invoice id, e.g. "K7QM-2XPD" (no look-alike characters). */
export function invoiceId() {
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  const bytes = crypto.randomBytes(8);
  let s = "";
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export const fakeTxHash = (seed) => base58(sha256(seed));
