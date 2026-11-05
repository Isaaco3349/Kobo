import "./env.js"; // must stay first: keeps tests away from the real .env and the real network
import crypto from "node:crypto";
import { canonical, memoPayload, dueMs, invoiceTotal, makeInvoiceId } from "../web/lib.js";
import { sha256hex } from "../server/ids.js";
import { createApp } from "../server/app.js";
import { Store } from "../server/store.js";
import { config as base } from "../server/config.js";

/** A freelancer: an ed25519 key whose public key hex IS the NEAR implicit account id. */
export function makeIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const account = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("hex");
  let nonce = 0;
  const sign = (method, args, over = {}) => {
    const delegate = { sender: account, receiver: base.contractId, method, args, nonce: ++nonce, expires_at_ms: Date.now() + 60_000, ...over };
    return { delegate, signature: crypto.sign(null, Buffer.from(canonical(delegate)), privateKey).toString("base64") };
  };
  return { account, sign };
}

export const sampleDetails = () => ({
  client_name: "Acme Studio Ltd", title: "Brand identity sprint", due_date: "2099-01-31", note: "Net 14",
  items: [
    { description: "Logo concepts", qty: "1", unit_price: "400" },
    { description: "Design hours", qty: "7.5", unit_price: "60" },
  ],
});

/** Build a correctly signed create_invoice envelope for given details. */
export function createEnvelope(id, details, ident, overrides = {}) {
  const memo_hash = sha256hex(canonical(memoPayload({ ...details, id, owner: ident.account })));
  const args = { id, amount: invoiceTotal(details.items), due_ms: dueMs(details.due_date), memo_hash, ...overrides };
  return ident.sign("create_invoice", args);
}

export const newId = () => makeInvoiceId(crypto.randomBytes(8));

export async function startApp(opts = {}) {
  if (base.mode !== "demo") throw new Error("Refusing to run tests in live mode (would use real keys)");
  const app = createApp({ config: { ...base, dbPath: null }, store: new Store(null), processingMs: 0, ...opts });
  await new Promise((r) => app.server.listen(0, r));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (path, init = {}) => {
    const res = await fetch(url + path, { ...init, headers: { "Content-Type": "application/json" }, body: init.body ? JSON.stringify(init.body) : undefined });
    const ct = res.headers.get("content-type") || "";
    return { status: res.status, body: ct.includes("json") ? await res.json() : await res.text() };
  };
  return { ...app, url, api, close: () => new Promise((r) => app.server.close(r)) };
}
