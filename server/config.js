// All runtime configuration lives here. Everything is overridable via env vars or a `.env` file
// (copy .env.example to .env; works the same on Windows, Mac and Linux).
import fs from "node:fs";
import { fileURLToPath } from "node:url";

function loadDotEnv(file = new URL("../.env", import.meta.url)) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    const v = m[2].replace(/^(['"])(.*)\1$/, "$2");
    if (process.env[m[1]] === undefined) process.env[m[1]] = v; // real env wins over the file
  }
}
loadDotEnv();

const env = process.env;
const network = env.NEAR_NETWORK === "mainnet" ? "mainnet" : "testnet";
const MAINNET_USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

export const config = {
  // "demo": everything runs locally, no keys, no network (mock Intents + mock NEAR ledger).
  // "live": real 1Click API + real NEAR RPC + real relayer/verifier keys (docs/LIVE.md).
  mode: env.KOBO_MODE === "live" ? "live" : "demo",
  port: Number(env.PORT || 3000),
  name: env.KOBO_NAME || "KOBO",
  tagline: "Invoices that settle themselves.",

  network,
  contractId: env.KOBO_CONTRACT || "kobo-invoices.testnet",
  verifierId: env.VERIFIER_ACCOUNT_ID || env.KOBO_VERIFIER || "kobo-verifier.testnet",
  rpcUrl: env.NEAR_RPC_URL || (network === "mainnet" ? "https://rpc.mainnet.near.org" : "https://rpc.testnet.near.org"),
  explorerTx: env.KOBO_EXPLORER_TX || (network === "mainnet" ? "https://nearblocks.io/txns/" : "https://testnet.nearblocks.io/txns/"),
  usdcContract: env.USDC_CONTRACT || (network === "mainnet" || env.KOBO_MODE !== "live" ? MAINNET_USDC : ""),

  oneClickUrl: env.ONECLICK_URL || "https://1click.chaindefuser.com",
  oneClickJwt: env.ONECLICK_JWT || "", // optional; without it 1Click charges its default fee

  relayerAccount: env.RELAYER_ACCOUNT_ID || "",
  relayerKey: env.RELAYER_PRIVATE_KEY || "", // "ed25519:..."; never commit; env only
  verifierKey: env.VERIFIER_PRIVATE_KEY || "",
  fundNear: env.RELAYER_FUND_NEAR || "0.001", // sent to a brand-new freelancer account so it exists on-chain

  dbPath: env.KOBO_DB || fileURLToPath(new URL("../data/db.json", import.meta.url)),
  pollMs: Number(env.KOBO_POLL_MS || 15000),

  // Relayer abuse limits: it only pays for these calls, to our contract, this many times per day.
  relayAllowedMethods: ["create_invoice", "cancel_invoice"],
  relayDailyLimit: Number(env.RELAY_DAILY_LIMIT || 50),
  relayMaxAgeMs: 10 * 60 * 1000,
  provisionPerIpHour: Number(env.PROVISION_PER_IP_HOUR || 10),
  provisionGlobalDay: Number(env.PROVISION_GLOBAL_DAY || 200),
};
