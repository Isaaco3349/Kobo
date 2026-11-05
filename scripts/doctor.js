// Checks everything live mode depends on and says exactly what is wrong.
//   npm run doctor
import { config } from "../server/config.js";
import { Rpc } from "../server/near-rpc.js";
import { parseKey } from "../server/chain-live.js";
import { LiveIntents } from "../server/intents.js";

let failed = 0, warned = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m, fix) => { failed++; console.log(`  ✗ ${m}${fix ? `\n      fix: ${fix}` : ""}`); };
const warn = (m, fix) => { warned++; console.log(`  ! ${m}${fix ? `\n      ${fix}` : ""}`); };
const near = (yocto) => (Number(BigInt(yocto) / 10n ** 18n) / 1e6).toFixed(4);
const step = async (title, fn) => {
  console.log(`\n${title}`);
  try { await fn(); }
  catch (e) { bad(`${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ""}`, /fetch failed/.test(e.message) ? "cannot reach the network: check your internet, VPN or firewall, or set NEAR_RPC_URL" : ""); }
};

console.log(`KOBO doctor  mode=${config.mode}  network=${config.network}  rpc=${config.rpcUrl}`);
if (config.mode !== "live") warn("KOBO_MODE is not 'live'", "Set KOBO_MODE=live in .env to run against NEAR. (Demo mode needs no setup.)");

const rpc = new Rpc(config.rpcUrl);

await step("1. Settings", async () => {
  const need = { RELAYER_ACCOUNT_ID: config.relayerAccount, RELAYER_PRIVATE_KEY: config.relayerKey, VERIFIER_PRIVATE_KEY: config.verifierKey, KOBO_CONTRACT: config.contractId, VERIFIER_ACCOUNT_ID: config.verifierId };
  for (const [k, v] of Object.entries(need)) v ? ok(`${k} is set`) : bad(`${k} is missing`, "copy .env.example to .env and fill it in (docs/LIVE.md)");
});

let relayerKey, verifierKey;
await step("2. Keys parse", async () => {
  for (const [name, str] of [["RELAYER_PRIVATE_KEY", config.relayerKey], ["VERIFIER_PRIVATE_KEY", config.verifierKey]]) {
    if (!str) continue;
    try { const k = parseKey(str); ok(`${name} is a valid ed25519 key (${k.pubStr.slice(0, 18)}…)`); name.startsWith("R") ? (relayerKey = k) : (verifierKey = k); }
    catch (e) { bad(`${name}: ${e.message}`, "it must look like ed25519:... (see the account's credentials file)"); }
  }
});

await step("3. NEAR RPC", async () => {
  const b = await rpc.finalBlock();
  ok(`reachable, latest block ${b.height}`);
});

await step("4. Relayer and verifier accounts", async () => {
  for (const [label, id, key, minNear] of [["relayer", config.relayerAccount, relayerKey, 0.5], ["verifier", config.verifierId, verifierKey, 0.05]]) {
    if (!id) continue;
    const acct = await rpc.viewAccount(id);
    if (!acct) { bad(`${label} account ${id} does not exist on ${config.network}`, "create it first (docs/LIVE.md, step 2)"); continue; }
    const bal = Number(near(acct.amount));
    bal >= minNear ? ok(`${label} ${id} exists, balance ${bal} NEAR`) : warn(`${label} ${id} balance is only ${bal} NEAR`, `fund it: the ${label} pays gas${label === "relayer" ? " and creates freelancers' accounts" : ""}`);
    if (key) {
      const n = await rpc.accessKeyNonce(id, key.pubStr);
      n === null ? bad(`${label}'s private key is not an access key of ${id}`, "use the key that belongs to this account") : ok(`${label}'s key is an access key of ${id}`);
    }
  }
});

await step("5. Invoice contract", async () => {
  const acct = await rpc.viewAccount(config.contractId);
  if (!acct) return bad(`${config.contractId} does not exist`, "deploy the contract (docs/LIVE.md, step 3)");
  let cfg;
  try { cfg = await rpc.viewFunction(config.contractId, "get_config", {}); }
  catch (e) { return bad(`${config.contractId} has no KOBO contract deployed (${e.message.slice(0, 80)})`, "deploy it with cargo near build + near contract deploy"); }
  ok(`deployed; get_config -> USDC ${cfg[0]}, verifier ${cfg[1]}`);
  cfg[1] === config.verifierId ? ok("contract's verifier matches VERIFIER_ACCOUNT_ID") : bad(`contract's verifier is ${cfg[1]} but VERIFIER_ACCOUNT_ID is ${config.verifierId}`, "redeploy/init the contract with the right verifier");
  if (config.usdcContract) {
    cfg[0] === config.usdcContract ? ok("contract's USDC matches USDC_CONTRACT") : warn(`contract's USDC is ${cfg[0]} but USDC_CONTRACT is ${config.usdcContract}`, "only matters for the trustless direct-USDC path");
    try {
      const sb = await rpc.viewFunction(config.usdcContract, "storage_balance_of", { account_id: config.contractId });
      sb ? ok("contract is registered with the USDC token (trustless direct payments can work)") : warn("contract is not registered with the USDC token", `register it: storage_deposit on ${config.usdcContract} for ${config.contractId}`);
    } catch { warn(`could not read ${config.usdcContract} on ${config.network}`, "fine on testnet if you use a placeholder USDC"); }
  }
});

await step("6. NEAR Intents (1Click)", async () => {
  const oc = new LiveIntents(config);
  const tokens = await oc.listTokens();
  ok(`token list loaded (${tokens.length} assets)`);
  const usdcNear = tokens.find((t) => t.symbol === "USDC" && t.blockchain === "near");
  if (!usdcNear) return bad("USDC on NEAR not in the token list");
  ok(`USDC on NEAR is ${usdcNear.assetId}`);
  if (config.usdcContract && usdcNear.contractAddress && usdcNear.contractAddress !== config.usdcContract)
    warn(`1Click's USDC contract is ${usdcNear.contractAddress}, USDC_CONTRACT is ${config.usdcContract}`, "set USDC_CONTRACT to the 1Click value for mainnet");
  // A dry quote charges nothing. Use a plain 64-hex account (valid on every network) as the recipient;
  // a testnet name like x.testnet is not a valid mainnet destination and 1Click rejects it.
  const recipient = relayerKey ? Buffer.from(relayerKey.pub).toString("hex") : "a".repeat(64);
  const routes = [["USDC", "arb"], ["USDC", "base"], ["USDC", "eth"], ["USDC", "sol"], ["ETH", "eth"], ["ETH", "arb"], ["ETH", "base"], ["USDT", "eth"], ["USDT", "arb"]];
  console.log("  testing payment routes (nothing is charged; takes about a minute)...");
  const refund = (chain) => (chain === "sol" ? "So11111111111111111111111111111111111111112" : "0x2527D02599Ba641c19FEa793cD0F167589a0f10D");
  let works = 0;
  for (const [sym, chain] of routes) {
    const t = tokens.find((x) => x.symbol === sym && x.blockchain === chain);
    if (!t) continue;
    let lastErr, hit = false;
    for (const usdc of [1, 10, 50]) { // some routes have a minimum amount
      try {
        const q = await oc.quote({ originAsset: t.assetId, amountOutUnits: String(usdc * 1e6), recipient, refundTo: refund(chain), deadline: new Date(Date.now() + 30 * 60 * 1000).toISOString(), dry: true });
        works++; hit = true;
        ok(`${sym} on ${chain}: pay ${q.quote.amountInFormatted} ${sym} for ${usdc}.00 USDC`);
        break;
      } catch (e) { lastErr = e; }
    }
    if (!hit) warn(`${sym} on ${chain}: ${lastErr.message}`);
  }
  if (!works) bad("no payment route could be quoted", "this comes from the NEAR Intents service and is usually temporary. Wait a few minutes and run the doctor again. The testnet rehearsal does not depend on it");
  else if (works < routes.length) console.log("  (routes marked ! are unavailable right now; clients can use any route marked \u2713)");
});

console.log(`\n${failed ? `✗ ${failed} problem(s)` : "✓ all required checks passed"}${warned ? `, ${warned} warning(s)` : ""}`);
process.exit(failed ? 1 : 0);
