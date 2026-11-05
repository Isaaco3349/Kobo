const base = "https://1click.chaindefuser.com";
const toks = await (await fetch(base + "/v0/tokens")).json();
const f = (s, c) => toks.find((t) => t.symbol === s && t.blockchain === c);
const id = (s, c) => f(s, c)?.assetId;
const ev = "0x2527D02599Ba641c19FEa793cD0F167589a0f10D";
const key = process.env.ONECLICK_JWT || "";
const post = async (body) => {
  const h = { "Content-Type": "application/json" };
  if (key) { h["X-API-Key"] = key; h.Authorization = "Bearer " + key; }
  const r = await fetch(base + "/v0/quote", { method: "POST", headers: h, body: JSON.stringify(body) });
  const t = await r.text();
  return r.status + " " + t.replace(/\s+/g, " ").slice(0, 150);
};
const mk = (o) => ({ dry: true, swapType: "EXACT_INPUT", slippageTolerance: 100, depositType: "ORIGIN_CHAIN", refundType: "ORIGIN_CHAIN", recipientType: "DESTINATION_CHAIN", deadline: new Date(Date.now() + 3600e3).toISOString(), ...o });
const nearUsdc = id("USDC", "near"), wnear = id("wNEAR", "near");
console.log("key sent:", !!key, "| wNEAR asset:", wnear);
const tests = {
  "1 USDC near -> wNEAR (same as website, on NEAR)": mk({ originAsset: nearUsdc, destinationAsset: wnear, amount: "12000000", refundTo: "near", recipient: "near" }),
  "2 wNEAR -> USDC near": mk({ originAsset: wnear, destinationAsset: nearUsdc, amount: "3000000000000000000000000", refundTo: "near", recipient: "near" }),
  "3 USDC arb -> USDC near (exact input)": mk({ originAsset: id("USDC", "arb"), destinationAsset: nearUsdc, amount: "12000000", refundTo: ev, recipient: "near" }),
  "4 USDC near -> USDC arb": mk({ originAsset: nearUsdc, destinationAsset: id("USDC", "arb"), amount: "12000000", refundTo: "near", recipient: ev }),
  "5 USDC eth -> USDC near": mk({ originAsset: id("USDC", "eth"), destinationAsset: nearUsdc, amount: "12000000", refundTo: ev, recipient: "near" }),
  "6 USDC arb -> wNEAR": mk({ originAsset: id("USDC", "arb"), destinationAsset: wnear, amount: "12000000", refundTo: ev, recipient: "near" }),
};
for (const [k, v] of Object.entries(tests)) console.log(k.padEnd(50), await post(v));