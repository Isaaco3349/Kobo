// Seeds demo data: one demo freelancer with three invoices (paid, awaiting payment, overdue).
// Writes data/db.json and data/demo-account.json. In the app, "Restore" -> pick demo-account.json
// to log in as this freelancer and see a populated dashboard.
//   npm run seed
import crypto from "node:crypto";
import fs from "node:fs";
import { createApp } from "../server/app.js";
import { config } from "../server/config.js";
import { canonical, memoPayload, dueMs, invoiceTotal, makeInvoiceId } from "../web/lib.js";
import { sha256hex } from "../server/ids.js";

if (config.mode !== "demo") { console.error("Seeding is demo-mode only."); process.exit(1); }
fs.rmSync(config.dbPath, { force: true });
const app = createApp({ processingMs: 0 });

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const jwk = privateKey.export({ format: "jwk" });
const account = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("hex");
let nonce = Date.now();
const sign = (method, args) => {
  const delegate = { sender: account, receiver: config.contractId, method, args, nonce: ++nonce, expires_at_ms: Date.now() + 60_000 };
  return { delegate, signature: crypto.sign(null, Buffer.from(canonical(delegate)), privateKey).toString("base64") };
};
const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);

const make = async (details) => {
  const id = makeInvoiceId(crypto.randomBytes(8));
  const memo_hash = sha256hex(canonical(memoPayload({ ...details, id, owner: account })));
  const env = sign("create_invoice", { id, amount: invoiceTotal(details.items), due_ms: dueMs(details.due_date), memo_hash });
  return await app.svc.create(details, env);
};

const paid = await make({ client_name: "Northwind Labs", title: "Smart contract audit, week 1", due_date: day(7), note: "Net 14", items: [{ description: "Audit hours", qty: "20", unit_price: "95" }, { description: "Written report", qty: "1", unit_price: "300" }] });
const open = await make({ client_name: "Acme Studio Ltd", title: "Brand identity sprint", due_date: day(14), note: "", items: [{ description: "Logo concepts", qty: "1", unit_price: "400" }, { description: "Design hours", qty: "7.5", unit_price: "60" }] });
const overdue = await make({ client_name: "Lagos Fintech Co", title: "Landing page build", due_date: day(-6), note: "Reminder sent", items: [{ description: "Frontend development", qty: "1", unit_price: "1200" }] });

const ETH = "nep141:eth.omft.near";
await app.svc.quote(paid.id, { originAsset: ETH, refundTo: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D" });
const att = paid.attempts[paid.attempts.length - 1];
app.intents.simulateDeposit(att.deposit_address, { outcome: "success", amountOut: paid.total, recipient: account });
await app.svc.refresh(paid.id);
app.store.save();

fs.mkdirSync("data", { recursive: true });
fs.writeFileSync("data/demo-account.json", JSON.stringify({ jwk, account, lastNonce: nonce }, null, 2));
console.log("Seeded demo data into", config.dbPath);
console.log("Demo account:", account);
console.log(`Invoices: paid ${paid.id}, unpaid ${open.id}, overdue ${overdue.id}`);
console.log("Start the app (npm start), then on the home page press Restore and choose data/demo-account.json");
