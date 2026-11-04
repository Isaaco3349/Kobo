import { createApp } from "./app.js";
import { config } from "./config.js";

let app;
try {
  app = createApp();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

app.server.listen(config.port, () => {
  console.log(`${config.name} running in ${config.mode.toUpperCase()} mode -> http://localhost:${config.port}`);
  if (config.mode === "demo") console.log("Demo mode: mock NEAR Intents + mock ledger. No keys, no network needed.");
  else console.log(`Live mode on NEAR ${config.network}: contract ${config.contractId}, relayer ${config.relayerAccount}.`);
});

// Settle payments in the background so statuses are right even when nobody has the page open.
let busy = false;
setInterval(async () => {
  if (busy) return;
  busy = true;
  try { await app.svc.pollPending(); } catch (e) { console.error("poller:", e.message); } finally { busy = false; }
}, config.pollMs).unref();
