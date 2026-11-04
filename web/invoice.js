import { $, $$, api, dots, esc, usd, short, fmtDate, fmtTime, pill, copy, initTheme, toast, countdown } from "./ui.js";
import { group } from "./lib.js";

initTheme();
const id = location.pathname.split("/").pop();
const CHAIN = { eth: "Ethereum", arb: "Arbitrum", base: "Base", sol: "Solana", btc: "Bitcoin", near: "NEAR", op: "Optimism", pol: "Polygon", bsc: "BNB Chain", tron: "Tron", ton: "TON", doge: "Dogecoin", xrp: "XRP Ledger" };
const chainName = (c) => CHAIN[c] || String(c).toUpperCase();

let cfg, tokens = [], view, timer, cdTimer, picked = { asset: "", refund: "" };

async function load(initial) {
  view = await api(`/api/invoices/${id}`);
  render();
  clearTimeout(timer);
  const live = view.status === "pending" || (view.attempt && view.status === "open");
  if (live) timer = setTimeout(() => load(false), 2500);
}

function tokenSelect() {
  const byChain = {};
  tokens.forEach((t) => (byChain[t.blockchain] ||= []).push(t));
  return Object.keys(byChain).sort().map((c) =>
    `<optgroup label="${esc(chainName(c))}">${byChain[c].map((t) => `<option value="${esc(t.assetId)}" ${t.assetId === picked.asset ? "selected" : ""}>${esc(t.symbol)} on ${esc(chainName(c))}</option>`).join("")}</optgroup>`).join("");
}

function txLink(hash, label) {
  return hash ? `<a href="/tx/${esc(hash)}">${esc(label || short(hash, 8, 6))}</a>` : "";
}

function render() {
  const v = view;
  const payable = ["open", "refunded"].includes(v.status) && !v.attempt;
  const a = v.attempt;
  const paidEv = v.events.find((e) => e.type === "paid");
  $("#root").innerHTML = `
    ${v.status === "paid" ? `<div class="paidbanner"><b>Paid in full</b><span>${fmtTime(v.paid_at)} · ${usd(v.total_formatted)} USDC delivered ${paidEv?.tx ? "· " + txLink(paidEv.tx, "settlement receipt").replace("<a ", '<a style="color:#fff" ') : ""}</span></div>` : ""}
    <div class="card">
      <div class="inv-head">
        <div><div class="eyebrow">Invoice ${esc(v.id)}</div><div style="margin-top:8px;font-size:12px" class="hint">From <b title="${esc(v.owner)}">${short(v.owner, 6, 6)}</b> · To <b>${esc(v.client_name)}</b></div></div>
        <div>${pill(v)}</div>
      </div>
      <h3 style="font-size:28px;margin-top:18px;letter-spacing:-.03em">${esc(v.title)}</h3>
      <div class="inv-amount">${dots(usd(v.total_formatted), { r: 3, gap: 9 })}</div>
      <div class="eyebrow">USDC · Due ${esc(v.due_date)}</div>
      ${["paid", "cancelled"].includes(v.status) ? "" : `<div class="due"><div class="dots-wrap" id="cd"></div><span class="eyebrow">${v.overdue ? "Overdue" : "d : h : m : s"}</span></div>`}
      <table class="lines"><thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Unit</th><th class="r">Amount</th></tr></thead><tbody>
        ${v.items.map((i) => { const amt = (Number(i.qty) * Number(i.unit_price)).toFixed(2); return `<tr><td>${esc(i.description)}</td><td class="r">${esc(i.qty)}</td><td class="r">${group(Number(i.unit_price).toFixed(2))}</td><td class="r">${group(amt)}</td></tr>`; }).join("")}
        <tr><td colspan="3" class="r"><b>Total (USDC)</b></td><td class="r"><b>${group(v.total_formatted)}</b></td></tr>
      </tbody></table>
      ${v.note ? `<p class="hint">${esc(v.note)}</p>` : ""}
      <div class="verify">${v.hash_matches_chain ? `<span class="ok">✓ Matches the on-chain record</span>` : `<span style="color:var(--red)">✗ Details do not match the on-chain record</span>`}
        <span>fingerprint ${short(v.memo_hash, 8, 6)}</span><span>·</span>${txLink(v.create_tx, "recorded in this transaction")}</div>
    </div>

    ${payable ? `<div class="card paybox" id="pay">
      <div class="eyebrow">Pay this invoice</div>
      <p class="hint" style="margin:8px 0 16px">Pay with whatever you already hold. NEAR Intents converts it so the invoice is settled in exactly ${usd(v.total_formatted)} USDC. You pay a small conversion spread on top.</p>
      <div class="field"><label for="tok">Pay with</label><select id="tok">${tokenSelect()}</select></div>
      <div class="field"><label for="ref">Your refund address <span id="refChain"></span></label><input id="ref" placeholder="Wallet address that funds go back to if anything fails" value="${esc(picked.refund)}"><span class="hint">Required by the exchange network. If the payment fails, your money returns here.</span></div>
      <button class="btn" id="getPay">Get payment details ↗</button> <span class="hint err" id="payMsg"></span>
    </div>` : ""}

    ${a ? `<div class="depo">
      <div class="eyebrow">Send exactly</div>
      <div class="amt">${esc(a.amount_in_formatted)} ${esc(a.origin_symbol)}</div>
      <div class="hint">on <b>${esc(chainName(a.origin_chain))}</b> · about $${esc(a.amount_in_usd)} · valid until ${fmtTime(Date.parse(a.deadline))}</div>
      <div class="addr"><code>${esc(a.deposit_address)}</code><button class="btn small" id="cpAddr">Copy</button></div>
      ${a.deposit_memo ? `<div class="hint" style="margin-top:8px">Memo (required): <b>${esc(a.deposit_memo)}</b></div>` : ""}
      <div class="hint" style="margin-top:10px">Send only ${esc(a.origin_symbol)} on ${esc(chainName(a.origin_chain))} to this address. This page updates by itself.</div>
      ${cfg.mode === "demo" ? `<div class="demo"><b>DEMO</b> no wallet needed here, so stand in for the client:
        <button class="btn small" id="simOk">Simulate payment</button><button class="btn ghost small" id="simRef">Simulate failed swap (refund)</button></div>` : ""}
    </div>` : ""}

    <div class="card" style="margin-top:16px">
      <div class="eyebrow">Status</div>
      <ul class="timeline">${[...v.events].reverse().map((e) => `<li class="${esc(e.type)}"><time>${fmtTime(e.at)}</time>${esc(e.text)} ${e.tx ? txLink(e.tx, "view receipt") : ""}</li>`).join("")}</ul>
    </div>`;

  clearInterval(cdTimer);
  const cd = $("#cd");
  if (cd) cdTimer = countdown(v.due_ms, cd);

  const tok = $("#tok");
  if (tok) {
    if (!picked.asset) picked.asset = tok.value;
    const setChain = () => { const t = tokens.find((x) => x.assetId === tok.value); $("#refChain").textContent = t ? `(${chainName(t.blockchain)} wallet)` : ""; };
    tok.onchange = () => { picked.asset = tok.value; setChain(); };
    setChain();
    $("#ref").oninput = (e) => (picked.refund = e.target.value);
    $("#getPay").onclick = getPay;
  }
  if ($("#cpAddr")) $("#cpAddr").onclick = (e) => copy(a.deposit_address, e.target);
  if ($("#simOk")) $("#simOk").onclick = () => sim("success");
  if ($("#simRef")) $("#simRef").onclick = () => sim("refund");
}

async function getPay() {
  const btn = $("#getPay");
  btn.disabled = true;
  $("#payMsg").textContent = "";
  try {
    await api(`/api/invoices/${id}/quote`, { method: "POST", body: { originAsset: picked.asset, refundTo: picked.refund } });
    await load();
  } catch (e) { $("#payMsg").textContent = e.message; btn.disabled = false; }
}
async function sim(outcome) {
  try { await api(`/api/demo/pay/${id}`, { method: "POST", body: { outcome } }); toast(outcome === "refund" ? "Simulated: swap failed, refunding" : "Simulated: client sent the funds"); await load(); }
  catch (e) { toast(e.message, "err"); }
}

(async () => {
  try {
    cfg = await api("/api/config");
    $("#modeTag").textContent = cfg.mode === "demo" ? "Demo" : cfg.network;
    tokens = await api("/api/tokens");
    document.title = `Invoice ${id} | KOBO`;
    await load(true);
  } catch (e) {
    $("#root").innerHTML = `<div class="empty">${esc(e.message)}<br><a href="/">Back to KOBO</a></div>`;
  }
})();
