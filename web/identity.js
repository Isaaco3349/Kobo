// The freelancer's account lives in their browser: an ed25519 key whose public key (hex) is
// their NEAR implicit account id. They never hold NEAR: the relayer pays gas for signed calls.
import { canonical } from "./lib.js";

const KEY = "kobo.identity.v1";
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));

export async function supported() {
  try { await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign"]); return true; } catch { return false; }
}

async function load() {
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  const { jwk, account, lastNonce } = JSON.parse(raw);
  const priv = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
  return { priv, account, lastNonce: lastNonce || 0, jwk };
}

export async function getIdentity() {
  let id = await load();
  if (id) return id;
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const account = toHex(await crypto.subtle.exportKey("raw", pair.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  localStorage.setItem(KEY, JSON.stringify({ jwk, account, lastNonce: 0 }));
  return load();
}

export async function signCall(method, args, contractId) {
  const id = await getIdentity();
  const nonce = Math.max(Date.now(), id.lastNonce + 1);
  const delegate = { sender: id.account, receiver: contractId, method, args, nonce, expires_at_ms: Date.now() + 5 * 60 * 1000 };
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, id.priv, new TextEncoder().encode(canonical(delegate)));
  const raw = JSON.parse(localStorage.getItem(KEY));
  raw.lastNonce = nonce;
  localStorage.setItem(KEY, JSON.stringify(raw));
  return { delegate, signature: b64(sig) };
}

export function backupKey() {
  const raw = localStorage.getItem(KEY);
  const blob = new Blob([raw], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "kobo-account-backup.json";
  a.click();
}

export async function restoreKey(text) {
  const parsed = JSON.parse(text);
  if (!parsed.jwk || !/^[0-9a-f]{64}$/.test(parsed.account)) throw new Error("Not a Kobo backup file");
  await crypto.subtle.importKey("jwk", parsed.jwk, { name: "Ed25519" }, false, ["sign"]); // validates
  localStorage.setItem(KEY, JSON.stringify({ jwk: parsed.jwk, account: parsed.account, lastNonce: parsed.lastNonce || 0 }));
}

export async function sha256hex(text) {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}
