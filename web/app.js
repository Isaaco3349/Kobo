import { $, $$, api, dots, esc, usd, short, fmtDate, pill, copy, initTheme, toast } from "./ui.js";
import { getIdentity, signCall, backupKey, restoreKey, supported, sha256hex } from "./identity.js";
import { canonical, memoPayload, dueMs, invoiceTotal, fromUnits, group, makeInvoiceId } from "./lib.js";

initTheme();
let cfg, me, pollTimer;

const MARQ = ["Any chain in", "USDC out", "Zero gas for you", "Receipts for your accountant", "Built on NEAR Intents", "Invoice links, not wallets"];
$("#marq").innerHTML = [...MARQ, ...MARQ, ...MARQ, ...MARQ].map((t) => `<span>${t}</span><em>✳</em>`).join("");

function setTotal(received) {
  const t = usd(received);
  $("#heroDots").innerHTML = dots(t, { r: 3, gap: 9 });
  $("#glanceDots").innerHTML = dots(t, { r: 3, gap: 9 });
}

function row(inv) {
  const link = `${location.origin}/i/${inv.id}`;
  return `<tr>
    <td><div class="id">${esc(inv.id)}</div><div class="sub">${fmtDate(inv.created_at)}</div></td>
    <td><div>${esc(inv.client_name)}</div><div class="sub">${esc(inv.title)}</div></td>
    <td class="hide-s">${esc(inv.due_date)}</td>
    <td>${usd(inv.total_formatted)}</td>
    <td>${pill(inv)}</td>
    <td class="r"><button class="btn ghost small" data-copy="${link}">Copy link</button> <a class="btn small" href="/i/${inv.id}" target="_blank" rel="noopener">Open</a></td>
  </tr>`;
}

async function refresh() {
  const data = await api(`/api/owners/${me.account}/invoices`);
  setTotal(data.summary.received);
  $("#sOut").textContent = usd(data.summary.outstanding);
  $("#sOver").textContent = data.summary.overdue;
  $("#sCount").textContent = data.summary.count;
  $("#sGas").textContent = data.sponsorship.total_calls;
  if (data.sponsorship.total_calls) {
    $("#gasNote").textContent = `The relayer paid ${data.sponsorship.total_near} NEAR${cfg.mode === "demo" ? " (simulated in demo mode)" : ""} across ${data.sponsorship.total_calls} calls. You paid nothing.`;
  }
  $("#list").innerHTML = data.invoices.length
    ? `<table class="invlist"><thead><tr><th>Invoice</th><th>Client</th><th class="hide-s">Due</th><th>Amount</th><th>Status</th><th class="r"></th></tr></thead><tbody>${data.invoices.map(row).join("")}</tbody></table>`
    : `<div class="empty">No invoices yet. Create your first one below.</div>`;
  $$("[data-copy]").forEach((b) => (b.onclick = () => copy(b.dataset.copy, b)));
  clearTimeout(pollTimer);
  if (data.invoices.some((i) => i.status === "pending")) pollTimer = setTimeout(refresh, 3000);
}

// ---- form ----------------------------------------------------------------------------------
function addItem(desc = "", qty = "1", price = "") {
  const d = document.createElement("div");
  d.className = "it";
  d.innerHTML = `<input class="d" placeholder="Description" maxlength="140" value="${esc(desc)}" required>
    <input class="q" inputmode="decimal" placeholder="Qty" value="${esc(qty)}" required>
    <input class="p" inputmode="decimal" placeholder="Unit USDC" value="${esc(price)}" required>
    <button type="button" class="x" aria-label="Remove line">×</button>`;
  d.querySelector(".x").onclick = () => { if ($$(".it").length > 1) { d.remove(); recalc(); } };
  d.querySelectorAll("input").forEach((i) => (i.oninput = recalc));
  $("#items").appendChild(d);
}
const readItems = () => $$(".it").map((r) => ({ description: $(".d", r).value.trim(), qty: $(".q", r).value.trim(), unit_price: $(".p", r).value.trim() }));
function recalc() {
  try { $("#total").textContent = usd(fromUnits(invoiceTotal(readItems()))); $("#formMsg").textContent = ""; }
  catch { $("#total").textContent = "$0.00"; }
}

$("#addItem").onclick = () => addItem();
$("#form").onsubmit = async (e) => {
  e.preventDefault();
  const btn = $("#submit");
  btn.disabled = true;
  $("#formMsg").className = "hint";
  $("#formMsg").textContent = "Signing and recording on NEAR…";
  try {
    const details = { client_name: $("#client").value.trim(), title: $("#title").value.trim(), due_date: $("#due").value, note: $("#note").value.trim(), items: readItems() };
    const total = invoiceTotal(details.items);
    if (BigInt(total) <= 0n) throw new Error("Total must be greater than zero");
    const id = makeInvoiceId(crypto.getRandomValues(new Uint8Array(8)));
    const memo_hash = await sha256hex(canonical(memoPayload({ ...details, id, owner: me.account })));
    const envelope = await signCall("create_invoice", { id, amount: total, due_ms: dueMs(details.due_date), memo_hash }, cfg.contractId);
    const inv = await api("/api/invoices", { method: "POST", body: { details, envelope } });
    const link = `${location.origin}/i/${inv.id}`;
    $("#created").hidden = false;
    $("#created").innerHTML = `<b>Invoice ${esc(inv.id)} is live.</b> Send this link to ${esc(inv.client_name)}:<br><a href="${link}" target="_blank" rel="noopener">${link}</a> <button class="btn small" type="button" id="cpy">Copy link</button>`;
    $("#cpy").onclick = (ev) => copy(link, ev.target);
    copy(link);
    $("#formMsg").textContent = "";
    e.target.reset(); $("#items").innerHTML = ""; addItem(); setDefaultDue(); recalc();
    await refresh();
    toast(`Invoice ${inv.id} created. Link copied.`);
  } catch (err) {
    $("#formMsg").className = "hint err";
    $("#formMsg").textContent = err.message;
  } finally { btn.disabled = false; }
};

function setDefaultDue() {
  const d = new Date(Date.now() + 14 * 864e5);
  $("#due").value = d.toISOString().slice(0, 10);
}

// ---- boot ----------------------------------------------------------------------------------
(async function boot() {
  cfg = await api("/api/config");
  $("#modeTag").textContent = cfg.mode === "demo" ? "Demo" : cfg.network;
  if (!(await supported())) {
    $("#form").insertAdjacentHTML("beforebegin", `<div class="callout" style="border-color:var(--red)">This browser lacks Ed25519 signing. Use a current Chrome, Edge, Firefox or Safari.</div>`);
    $("#submit").disabled = true;
    me = { account: "0".repeat(64) };
  } else {
    me = await getIdentity();
  }
  $("#stageAcct").textContent = short(me.account, 6, 6);
  $("#acctFull").textContent = me.account;
  $("#csv").href = `/api/owners/${me.account}/export.csv`;
  $("#copyAcct").onclick = (e) => copy(me.account, e.target);
  $("#backup").onclick = backupKey;
  $("#restore").onchange = async (e) => {
    try { await restoreKey(await e.target.files[0].text()); toast("Account restored. Reloading."); setTimeout(() => location.reload(), 600); }
    catch (err) { toast(err.message, "err"); }
  };
  addItem(); setDefaultDue(); recalc();
  setTotal("0.00");
  await refresh();
})().catch((e) => toast(e.message, "err"));
