import { createApp } from "./app.js";
import { config } from "./config.js";

try {
  const app = createApp();
  app.server.listen(config.port, () => {
    console.log(`${config.name} running in ${config.mode.toUpperCase()} mode -> http://localhost:${config.port}`);
    if (config.mode === "demo") console.log("Demo mode: mock NEAR Intents + mock ledger. No keys, no network needed.");
  });
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
