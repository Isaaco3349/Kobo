// All runtime configuration lives here. Everything is overridable via env vars.
const env = process.env;

export const config = {
  // "demo": everything runs locally, no keys, no network (mock Intents + mock NEAR ledger).
  // "live": real 1Click API + real NEAR RPC + real relayer key (see README, "Live mode").
  mode: env.KOBO_MODE === "live" ? "live" : "demo",
  port: Number(env.PORT || 3000),
  name: env.KOBO_NAME || "KOBO",
  tagline: "Invoices that settle themselves.",

  network: env.NEAR_NETWORK || "testnet",
  contractId: env.KOBO_CONTRACT || "kobo-invoices.testnet",
  verifierId: env.KOBO_VERIFIER || "kobo-verifier.testnet",
  rpcUrl: env.NEAR_RPC_URL || "https://rpc.testnet.near.org",
  explorerTx: env.KOBO_EXPLORER_TX || "https://testnet.nearblocks.io/txns/",

  oneClickUrl: env.ONECLICK_URL || "https://1click.chaindefuser.com",
  oneClickJwt: env.ONECLICK_JWT || "", // optional; without it 1Click charges its default fee

  relayerAccount: env.RELAYER_ACCOUNT_ID || "",
  relayerKey: env.RELAYER_PRIVATE_KEY || "", // never commit this; env only
  verifierKey: env.VERIFIER_PRIVATE_KEY || "",

  dbPath: env.KOBO_DB || new URL("../data/db.json", import.meta.url).pathname,

  // Relayer abuse limits: it only pays for these calls, to our contract, this many times per day.
  relayAllowedMethods: ["create_invoice", "cancel_invoice"],
  relayDailyLimit: Number(env.RELAY_DAILY_LIMIT || 50),
  relayMaxAgeMs: 10 * 60 * 1000,
};
