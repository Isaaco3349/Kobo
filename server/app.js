import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as defaultConfig } from "./config.js";
import { Store } from "./store.js";
import { MockChain } from "./chain.js";
import { LiveChain } from "./chain-live.js";
import { MockIntents, LiveIntents } from "./intents.js";
import { Invoices } from "./invoices.js";
import { ApiError, RelayError } from "./errors.js";
import { relay } from "./relay.js";
import { invoicesToCsv } from "./csv.js";
import { fromUnits } from "../web/lib.js";

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json" };

const LIVE_REQUIRED = { relayerAccount: "RELAYER_ACCOUNT_ID", relayerKey: "RELAYER_PRIVATE_KEY", verifierKey: "VERIFIER_PRIVATE_KEY", contractId: "KOBO_CONTRACT" };

export function createApp({ config = defaultConfig, store, chain, intents, processingMs } = {}) {
  store ??= new Store(config.dbPath);
  if (config.mode === "live") {
    const missing = Object.entries(LIVE_REQUIRED).filter(([k]) => !config[k]).map(([, env]) => env);
    if (!chain && missing.length) throw new Error(`Live mode needs these settings: ${missing.join(", ")}. See docs/LIVE.md (or copy .env.example to .env).`);
    chain ??= new LiveChain({ config, store });
    intents ??= new LiveIntents(config);
  } else {
    chain ??= new MockChain(store, config);
    intents ??= new MockIntents(store, processingMs !== undefined ? { processingMs } : {});
  }
  const svc = new Invoices({ store, chain, intents, config });

  // Provisioning creates real accounts on-chain at the relayer's expense, so it is rate limited.
  const hits = new Map();
  let globalDay = { day: "", n: 0 };
  function limitProvisioning(ip) {
    if (config.mode !== "live") return;
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter((t) => now - t < 3600_000);
    if (recent.length >= config.provisionPerIpHour) throw new ApiError("Too many account setups from this address. Try again later.", 429);
    const day = new Date(now).toISOString().slice(0, 10);
    if (globalDay.day !== day) globalDay = { day, n: 0 };
    if (globalDay.n >= config.provisionGlobalDay) throw new ApiError("Daily account setup limit reached.", 429);
    recent.push(now); hits.set(ip, recent); globalDay.n++;
  }

  const json = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on("data", (c) => { size += c.length; if (size > 64 * 1024) { reject(new ApiError("Body too large", 413)); req.destroy(); } else chunks.push(c); });
      req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { reject(new ApiError("Invalid JSON")); } });
      req.on("error", reject);
    });
  const sendFile = (res, file) => {
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end("Not found"); }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
      res.end(buf);
    });
  };
  const txUrlBase = (url) => (config.mode === "demo" ? `${url.origin}/tx/` : config.explorerTx);

  async function route(req, res, url) {
    const p = url.pathname;
    const m = req.method;
    let g;

    if (m === "GET" && p === "/api/config") {
      return json(res, 200, {
        name: config.name, tagline: config.tagline, mode: config.mode, network: config.network,
        contractId: config.contractId, relayerAccount: config.relayerAccount || "kobo-relayer.testnet",
        usdcContract: config.usdcContract, explorerTx: config.explorerTx, allowedMethods: config.relayAllowedMethods, now: Date.now(),
      });
    }
    if (m === "GET" && p === "/api/tokens") return json(res, 200, await intents.listTokens());

    if ((g = p.match(/^\/api\/prepare\/([0-9a-f]{64})$/)) && m === "GET") {
      limitProvisioning(req.socket.remoteAddress || "?");
      return json(res, 200, await chain.prepare(g[1]));
    }
    if (m === "POST" && p === "/api/invoices") {
      const body = await readBody(req);
      const inv = await svc.create(body.details, body.envelope);
      return json(res, 201, await svc.publicView(inv));
    }
    if (m === "POST" && p === "/api/relay") {
      const body = await readBody(req);
      return json(res, 200, await relay(chain, config, body));
    }
    if ((g = p.match(/^\/api\/invoices\/([A-Z0-9-]{9})$/)) && m === "GET") {
      return json(res, 200, await svc.publicView(await svc.refresh(g[1])));
    }
    if ((g = p.match(/^\/api\/invoices\/([A-Z0-9-]{9})\/quote$/)) && m === "POST") {
      return json(res, 200, await svc.quote(g[1], await readBody(req)));
    }
    if ((g = p.match(/^\/api\/invoices\/([A-Z0-9-]{9})\/deposit$/)) && m === "POST") {
      return json(res, 200, await svc.submitDeposit(g[1], String((await readBody(req)).txHash || "")));
    }
    if ((g = p.match(/^\/api\/invoices\/([A-Z0-9-]{9})\/cancel$/)) && m === "POST") {
      const body = await readBody(req);
      return json(res, 200, await svc.publicView(await svc.cancel(g[1], body.envelope)));
    }
    if ((g = p.match(/^\/api\/owners\/([0-9a-f]{64})\/invoices$/)) && m === "GET") {
      const list = [];
      for (const inv of store.listByOwner(g[1])) list.push(await svc.publicView(await svc.refresh(inv.id)));
      const sums = list.reduce((a, i) => {
        if (i.status === "paid") a.received += BigInt(i.total);
        else if (i.status !== "cancelled") a.outstanding += BigInt(i.total);
        if (i.overdue) a.overdue += 1;
        return a;
      }, { received: 0n, outstanding: 0n, overdue: 0 });
      return json(res, 200, {
        owner: g[1], invoices: list,
        summary: { received: fromUnits(sums.received), outstanding: fromUnits(sums.outstanding), overdue: sums.overdue, count: list.length },
        sponsorship: await chain.sponsorship(g[1]),
      });
    }
    if ((g = p.match(/^\/api\/owners\/([0-9a-f]{64})\/export\.csv$/)) && m === "GET") {
      for (const inv of store.listByOwner(g[1])) await svc.refresh(inv.id);
      const csv = invoicesToCsv(store.listByOwner(g[1]).reverse(), { explorerTx: txUrlBase(url) });
      res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="kobo-invoices-${new Date().toISOString().slice(0, 10)}.csv"` });
      return res.end(csv);
    }
    if ((g = p.match(/^\/api\/tx\/([1-9A-HJ-NP-Za-km-z]{30,50})$/)) && m === "GET") {
      const tx = await chain.getTx(g[1]);
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
    if ((g = p.match(/^\/api\/demo\/direct\/([A-Z0-9-]{9})$/)) && m === "POST") {
      if (config.mode !== "demo") throw new ApiError("Not available", 404);
      svc._need(g[1]);
      try { chain.simulateDirectUsdcPayment(g[1]); } catch (e) { throw new ApiError(e.message, 409); }
      return json(res, 200, { ok: true });
    }

    // ---- pages ----
    if (m === "GET" && /^\/i\/[A-Z0-9-]{9}$/.test(p)) return sendFile(res, path.join(WEB, "invoice.html"));
    if (m === "GET" && /^\/tx\/[1-9A-HJ-NP-Za-km-z]{30,50}$/.test(p)) return sendFile(res, path.join(WEB, "tx.html"));
    if (m === "GET") {
      const file = path.join(WEB, p === "/" ? "index.html" : p.slice(1));
      if (!file.startsWith(WEB + path.sep)) { res.writeHead(403); return res.end(); }
      return sendFile(res, file);
    }
    throw new ApiError("Not found", 404);
  }

  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res, new URL(req.url, `http://${req.headers.host || "localhost"}`));
    } catch (e) {
      if (e instanceof ApiError) return json(res, e.status || 400, { error: e.message });
      console.error(e);
      json(res, 500, { error: "Internal error" });
    }
  });
  return { server, store, chain, intents, svc, config };
}
