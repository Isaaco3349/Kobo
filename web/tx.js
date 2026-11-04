import { $, api, esc, fmtTime, initTheme } from "./ui.js";
import { fromUnits } from "./lib.js";

initTheme();
const hash = location.pathname.split("/").pop();

(async () => {
  try {
    const [cfg, tx] = await Promise.all([api("/api/config"), api(`/api/tx/${hash}`)]);
    const gasLine = tx.relayed
      ? `<div class="callout"><b>Gasless.</b> <code>${esc(tx.predecessor.slice(0, 10))}…</code> authorised this call with their own signature. <code>${esc(tx.signer)}</code> paid the network fee${tx.sim_fee_near ? ` (about ${tx.sim_fee_near} NEAR${cfg.mode === "demo" ? ", simulated" : ""})` : ""}. The contract saw the real user, not the relayer.</div>`
      : "";
    const amt = tx.args?.amount && /^\d+$/.test(String(tx.args.amount)) ? ` (${fromUnits(tx.args.amount)} USDC)` : "";
    $("#root").innerHTML = `
      <div class="card">
        <div class="eyebrow">${cfg.mode === "demo" ? "Demo ledger receipt" : "Transaction"}</div>
        <h3 style="font-size:30px;margin:14px 0 6px">${esc(tx.method)}</h3>
        <div class="hint">${tx.outcome === "SuccessValue" ? '<b style="color:var(--ok)">Succeeded</b>' : '<b style="color:var(--red)">Failed: ' + esc(tx.error) + "</b>"} · ${fmtTime(tx.ts)}</div>
        ${gasLine}
        <table class="kv">
          <tr><td>Hash</td><td style="word-break:break-all">${esc(tx.hash)}</td></tr>
          <tr><td>Called by (predecessor)</td><td style="word-break:break-all">${esc(tx.predecessor)}</td></tr>
          <tr><td>Gas paid by (signer)</td><td style="word-break:break-all">${esc(tx.gas_paid_by)}</td></tr>
          <tr><td>Contract</td><td>${esc(tx.receiver)}</td></tr>
          <tr><td>Block</td><td>${tx.height}</td></tr>
          <tr><td>Arguments${amt}</td><td><pre>${esc(JSON.stringify(tx.args, null, 2))}</pre></td></tr>
        </table>
        ${cfg.mode === "demo" ? `<p class="hint" style="margin-top:16px">This is the local demo ledger. In live mode every receipt links to a real NEAR explorer.</p>` : ""}
      </div>`;
  } catch (e) {
    $("#root").innerHTML = `<div class="empty">${esc(e.message)}<br><a href="/">Back to KOBO</a></div>`;
  }
})();
