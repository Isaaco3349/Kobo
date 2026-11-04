import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as defaultConfig } from "./config.js";
import { Store } from "./store.js";
import { MockChain } from "./chain.js";
import { MockIntents, LiveIntents, DEMO_USDC_NEAR } from "./intents.js";
import { Invoices, ApiError } from "./invoices.js";
import { relay, RelayError } from "./relay.js";
import { invoicesToCsv } from "./csv.js";
import { fromUnits, HEX64 } from "../web/lib.js";

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json" };

export function createApp({ config = defaultConfig, store, chain, intents, processingMs } = {}) {
  store ??= new Store(config.dbPath);
  if (config.mode === "live") {
    throw new Error("Live mode adapters are not wired yet. Run with KOBO_MODE=demo (default). See README, 'Live mode'.");
  }
  chain ??= new MockChain(store, config);
  intents ??= new MockIntents(store, processingMs !== undefined ? { processingMs } : {});
  const svc = new Invoices({ store, chain, intents, config });

  const json = (res, status, body) => {
    const s = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(s);
  };
  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on("data", (c) => { size += c.length; if (size > 64 * 1024) { reject(new ApiError("Body too large", 413)); req.destroy(); } else chunks.push(c); });
      req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { reject(new ApiError("Invalid JSON")); } });
      req.on("error", reject);
    });

  const sendFile = (res, file, extraHeaders = {}) => {
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end("Not found"); }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", ...extraHeaders });
      res.end(buf);
    });
  };

  const txView = (tx) => ({ ...tx, explorer_url: null });

  async function route(req, res, url) {
    const p = url.pathname;
    const m = req.method;
    let g;

    if (m === "GET" && p === "/api/config") {
      return json(res, 200, {
        name: config.name, tagline: config.tagline, mode: config.mode, network: config.network,
        contractId: config.contractId, relayerAccount: config.relayerAccount || "kobo-relayer.testnet",
        allowedMethods: config.relayAllowedMethods, now: Date.now(),
      });
    }
    if (m === "GET" && p === "/api/tokens") {
      const tokens = (await intents.listTokens()).filter((t) => t.symbol !== undefined);
      return json(res, 200, tokens);
    }
    if (m === "POST" && p === "/api/invoices") {
      const body = await readBody(req);
      const inv = svc.create(body.details, body.envelope);
      return json(res, 201, svc.publicView(inv));
    }
    if (m === "POST" && p === "/api/relay") {
      const body = await readBody(req);
      try { return json(res, 200, txView(relay(chain, config, body))); }
      catch (e) { if (e instanceof RelayError) throw new ApiError(e.message, e.status); throw e; }
    }
    if ((g = p.match(/^\/api\/invoices\/([A-Z0-9-]{9})$/)) && m === "GET") {
      const inv = await svc.refresh(g[1]);
      return json(res, 200, svc.publicView(inv));
    }
    if ((g = p.match(/^\/api\/invoices\/([A-Z0-9-]{9})\/quote$/)) && m === "POST") {
      const body = await readBody(req);
      const attempt = await svc.quote(g[1], body);
      return json(res, 200, attempt);
    }
    if ((g = p.match(/^\/api\/invoices\/([A-Z0-9-]{9})\/deposit$/)) && m === "POST") {
      const body = await readBody(req);
      const inv = svc._need(g[1]);
      const att = inv.attempts[inv.attempts.length - 1];
      if (!att) throw new ApiError("No payment in progress", 409);
      await intents.submitDeposit(String(body.txHash || ""), att.deposit_address);
      return json(res, 200, { ok: true });
    }
    if ((g = p.match(/^\/api\/owners\/([0-9a-f]{64})\/invoices$/)) && m === "GET") {
      const list = [];
      for (const inv of store.listByOwner(g[1])) list.push(svc.publicView(await svc.refresh(inv.id)));
      const sums = list.reduce((a, i) => {
        if (i.status === "paid") a.received += BigInt(i.total);
        else if (i.status !== "cancelled") a.outstanding += BigInt(i.total);
        if (i.overdue) a.overdue += 1;
        return a;
      }, { received: 0n, outstanding: 0n, overdue: 0 });
      return json(res, 200, {
        owner: g[1], invoices: list,
        summary: { received: fromUnits(sums.received), outstanding: fromUnits(sums.outstanding), overdue: sums.overdue, count: list.length },
        sponsorship: chain.sponsorship(g[1]),
      });
    }
    if ((g = p.match(/^\/api\/owners\/([0-9a-f]{64})\/export\.csv$/)) && m === "GET") {
      for (const inv of store.listByOwner(g[1])) await svc.refresh(inv.id);
      const csv = invoicesToCsv(store.listByOwner(g[1]).reverse(), { explorerTx: `${url.origin}/tx/` });
      res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="kobo-invoices-${new Date().toISOString().slice(0, 10)}.csv"` });
      return res.end(csv);
    }
    if ((g = p.match(/^\/api\/tx\/([1-9A-HJ-NP-Za-km-z]{30,50})$/)) && m === "GET") {
      const tx = chain.getTx(g[1]);
      if (!tx) throw new ApiError("Transaction not found", 404);
      return json(res, 200, tx);
    }

    // ---- demo-only: stand in for the client's wallet ----
    if ((g = p.match(/^\/api\/demo\/pay\/([A-Z0-9-]{9})$/)) && m === "POST") {
      if (config.mode !== "demo") throw new ApiError("Not available", 404);
      const body = await readBody(req);
      const inv = svc._need(g[1]);
      const att = inv.attempts[inv.attempts.length - 1];
      if (!att || att.finalised) throw new ApiError("Request payment details first", 409);
      intents.simulateDeposit(att.deposit_address, { outcome: body.outcome === "refund" ? "refund" : "success", amountOut: inv.total, recipient: inv.owner });
      return json(res, 200, { ok: true });
    }

    // ---- pages ----
    if (m === "GET" && /^\/i\/[A-Z0-9-]{9}$/.test(p)) return sendFile(res, path.join(WEB, "invoice.html"));
    if (m === "GET" && /^\/tx\/[1-9A-HJ-NP-Za-km-z]{30,50}$/.test(p)) return sendFile(res, path.join(WEB, "tx.html"));
    if (m === "GET") {
      const rel = p === "/" ? "index.html" : p.slice(1);
      const file = path.join(WEB, rel);
      if (!file.startsWith(WEB + path.sep)) { res.writeHead(403); return res.end(); }
      return sendFile(res, file);
    }
    throw new ApiError("Not found", 404);
  }

  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res, new URL(req.url, `http://${req.headers.host || "localhost"}`));
    } catch (e) {
      if (e instanceof ApiError || e instanceof RelayError) return json(res, e.status || 400, { error: e.message });
      console.error(e);
      json(res, 500, { error: "Internal error" });
    }
  });
  return { server, store, chain, intents, svc, config, DEMO_USDC_NEAR };
}
