// Tries several variants of a 1Click dry quote to see what the service accepts.  npm run probe
const base = "https://1click.chaindefuser.com";
const post = async (body) => { const r = await fetch(base + "/v0/quote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); const t = await r.text(); return `${r.status} ${t.slice(0, 160).replace(/\s+/g, " ")}`; };
const toks = await (await fetch(base + "/v0/tokens")).json();
const f = (s, c) => toks.find((t) => t.symbol === s && t.blockchain === c);
const dest = f("USDC", "near").assetId, usdcArb = f("USDC", "arb").assetId, usdcBase = f("USDC", "base").assetId, wnear = f("wNEAR", "near")?.assetId;
const ev = "0x2527D02599Ba641c19FEa793cD0F167589a0f10D";
const mk = (o) => ({ dry: true, swapType: "EXACT_OUTPUT", slippageTolerance: 100, originAsset: usdcArb, depositType: "ORIGIN_CHAIN", destinationAsset: dest, amount: "10000000", refundTo: ev, refundType: "ORIGIN_CHAIN", recipient: "a".repeat(64), recipientType: "DESTINATION_CHAIN", deadline: new Date(Date.now() + 3600e3).toISOString(), ...o });
const tests = {
  "A current (exact output, 64-hex recipient)": mk({}),
  "B exact input 10 USDC": mk({ swapType: "EXACT_INPUT" }),
  "C recipient = existing account 'near'": mk({ recipient: "near" }),
  "D recipient = existing account 'aurora'": mk({ recipient: "aurora" }),
  "E origin USDC on base": mk({ originAsset: usdcBase }),
  "F slippage 300": mk({ slippageTolerance: 300 }),
  "G NEAR to USDC (wNEAR origin, NEAR deposit)": wnear ? mk({ originAsset: wnear, depositType: "ORIGIN_CHAIN", refundTo: "near", recipient: "near" }) : null,
};
for (const [k, v] of Object.entries(tests)) { if (v) console.log(k.padEnd(48), await post(v)); }
