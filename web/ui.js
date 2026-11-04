import { dotSvg } from "./dotfont.js";
import { group } from "./lib.js";

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const usd = (decimalStr) => "$" + group(decimalStr);
export const short = (s, a = 6, b = 4) => (s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s);
export const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
export const fmtTime = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export const dots = (text, opts) => dotSvg(text, opts);

/** Demo receipts live on our own /tx page; live receipts go to the public NEAR explorer. */
export const txUrl = (cfg, hash) => (cfg.mode === "demo" ? `/tx/${hash}` : `${cfg.explorerTx}${hash}`);

export const STATUS_LABEL = { open: "Unpaid", pending: "In progress", paid: "Paid", refunded: "Refunded", cancelled: "Cancelled" };
export function pill(inv) {
  const key = inv.overdue && inv.status !== "pending" ? "overdue" : inv.status;
  const label = key === "overdue" ? "Overdue" : STATUS_LABEL[inv.status] || inv.status;
  return `<span class="pill pill-${key}">${label}</span>`;
}

export function copy(text, btn) {
  navigator.clipboard?.writeText(text).then(() => {
    if (!btn) return;
    const old = btn.textContent;
    btn.textContent = "Copied";
    setTimeout(() => (btn.textContent = old), 1200);
  });
}

/** Theme: follows the OS until the user flips the switch. */
export function initTheme() {
  const saved = localStorage.getItem("kobo.theme");
  const prefers = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  document.documentElement.dataset.theme = saved || prefers;
  const btn = $("#theme");
  if (btn) btn.onclick = () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("kobo.theme", next);
  };
}

export function toast(msg, kind = "") {
  let el = $("#toast");
  if (!el) { el = document.createElement("div"); el.id = "toast"; document.body.appendChild(el); }
  el.className = `show ${kind}`;
  el.textContent = msg;
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.className = ""), 4200);
}

/** Dot-matrix countdown to a due date: "09:14:22:05" (days:hours:min:sec) */
export function countdown(targetMs, el) {
  const tick = () => {
    let d = Math.max(0, targetMs - Date.now());
    const days = Math.floor(d / 864e5); d %= 864e5;
    const h = Math.floor(d / 36e5); d %= 36e5;
    const m = Math.floor(d / 6e4); const s = Math.floor((d % 6e4) / 1e3);
    const p = (n) => String(n).padStart(2, "0");
    el.innerHTML = dots(`${p(Math.min(days, 99))}:${p(h)}:${p(m)}:${p(s)}`, { r: 2, gap: 6 });
  };
  tick();
  return setInterval(tick, 1000);
}
