// The freelancer's account lives in their browser: an ed25519 key whose public key (hex) is
// their NEAR implicit account id. They never hold NEAR: the relayer pays gas for signed calls.
import { buildEnvelope } from "./sign.js";
import { nearKeyFromJwk } from "./nearkey.js";

const KEY = "kobo.identity.v1";
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function supported() {
  try { await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign"]); return true; } catch { return false; }
}

async function load() {
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  const { jwk, account } = JSON.parse(raw);
  const priv = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
  return { priv, account, jwk };
}

export async function getIdentity() {
  const id = await load();
  if (id) return id;
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const account = toHex(await crypto.subtle.exportKey("raw", pair.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  localStorage.setItem(KEY, JSON.stringify({ jwk, account }));
  return load();
}

/** Ask the server for a fresh nonce/expiry (and, live, to set the account up), then sign locally. */
export async function signCall(method, args, cfg) {
  const id = await getIdentity();
  const res = await fetch(`/api/prepare/${id.account}`);
  const prep = await res.json();
  if (!res.ok) throw new Error(prep.error || "Could not prepare the call");
  return buildEnvelope({
    mode: cfg.mode, sender: id.account, receiver: cfg.contractId, method, args, prep,
    sha256: async (b) => new Uint8Array(await crypto.subtle.digest("SHA-256", b)),
    sign: async (m) => new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, id.priv, m)),
  });
}

/** The key in NEAR's own format, for importing the account into a NEAR wallet. Never sent anywhere. */
export function exportForNear() {
  const raw = JSON.parse(localStorage.getItem(KEY) || "null");
  if (!raw) throw new Error("No account found in this browser");
  const k = nearKeyFromJwk(raw.jwk);
  if (k.accountId !== raw.account) throw new Error("Stored key does not match the account. Restore your backup file.");
  return { account: raw.account, privateKey: k.privateKey };
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
  localStorage.setItem(KEY, JSON.stringify({ jwk: parsed.jwk, account: parsed.account }));
}

export async function sha256hex(text) {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}
