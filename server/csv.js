// Accountant-ready CSV. Plain-English column names, one row per invoice, UTC dates,
// amounts as plain decimals (no thousands separators), UTF-8 with BOM so Excel opens it cleanly.
import { fromUnits } from "../web/lib.js";

const COLUMNS = [
  "Invoice number", "Issue date (UTC)", "Due date", "Client", "Title", "Line items",
  "Invoice total (USDC)", "Status", "Paid date (UTC)", "Amount received (USDC)",
  "Client paid with", "Client sent (amount)", "Client sent (USD value at quote)",
  "Conversion cost (USD)", "Settlement transaction", "Invoice record transaction", "Refund transaction", "Notes",
];

const esc = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  // Neutralise spreadsheet formula injection from user-supplied text.
  const safe = /^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s)) ? "'" + s : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : "");
const STATUS = { open: "Unpaid", pending: "Payment in progress", paid: "Paid", refunded: "Unpaid (payment was refunded)", cancelled: "Cancelled" };

export function invoicesToCsv(invoices, { explorerTx = "" } = {}) {
  const rows = [COLUMNS];
  for (const inv of invoices) {
    const att = [...inv.attempts].reverse().find((a) => a.settle_tx || a.intents_status === "SUCCESS") || inv.attempts[inv.attempts.length - 1];
    const paid = inv.status === "paid";
    const cost = paid && att?.amount_in_usd ? (Number(att.amount_in_usd) - Number(fromUnits(inv.total))).toFixed(2) : "";
    const link = (h) => (h ? explorerTx + h : "");
    rows.push([
      inv.id, day(inv.created_at), inv.due_date, inv.client_name, inv.title,
      inv.items.map((i) => `${i.qty} x ${i.description} @ ${i.unit_price}`).join("; "),
      fromUnits(inv.total), STATUS[inv.status] || inv.status, paid ? day(inv.paid_at) : "",
      paid ? fromUnits(inv.total) : "0.00",
      paid && att ? `${att.origin_symbol} on ${att.origin_chain.toUpperCase()}` : "",
      paid && att ? att.amount_in_formatted : "", paid && att ? att.amount_in_usd : "", cost,
      paid && att ? link(att.settle_tx) : "", link(inv.create_tx), att?.refund_tx ? link(att.refund_tx) : "", inv.note || "",
    ]);
  }
  return "﻿" + rows.map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n";
}
