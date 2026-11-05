const base = "https://1click.chaindefuser.com";
const toks = await (await fetch(base + "/v0/tokens")).json();
const f = (s, c) => toks.find((t) => t.symbol === s && t.blockchain === c);
const ARB = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
const SOL = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";
const ev = "0x2527D02599Ba641c19FEa793cD0F167589a0f10D";
const solAddr = "13QkxhNMrTPxoCkRdYdJ65tFuwXPhL5gLS2Z5Nr6gjRK";
const hex64 = "a".repeat(64);
const nearUsdc = f("USDC", "near"), baseUsdc = f("USDC", "base"), ethUsdc = f("USDC", "eth");
console.log("USDC near:", JSON.stringify(nearUsdc));
console.log("near-chain tokens:", toks.filter((t) => t.blockchain === "near").map((t) => t.symbol).join(","));
const post = async (b) => {
  const r = await fetch(base + "/v0/quote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dry: true, slippageTolerance: 100, originAsset: ARB, depositType: "ORIGIN_CHAIN", refundTo: ev, refundType: "ORIGIN_CHAIN", recipientType: "DESTINATION_CHAIN", deadline: new Date(Date.now() + 3600e3).toISOString(), ...b }) });
  const t = await r.text(); return r.status + " " + (r.status === 201 ? "OK quote" : t.replace(/\s+/g, " ").slice(0, 90));
};
const T = {
  "a arb->sol EXACT_INPUT (doc)":          { swapType: "EXACT_INPUT", destinationAsset: SOL, amount: "1000000", recipient: solAddr },
  "b arb->sol EXACT_OUTPUT":               { swapType: "EXACT_OUTPUT", destinationAsset: SOL, amount: "1000000", recipient: solAddr },
  "c arb->base USDC EXACT_OUTPUT":         { swapType: "EXACT_OUTPUT", destinationAsset: baseUsdc?.assetId, amount: "1000000", recipient: ev },
  "d arb->eth USDC EXACT_INPUT":           { swapType: "EXACT_INPUT", destinationAsset: ethUsdc?.assetId, amount: "1000000", recipient: ev },
  "e arb->USDC near, input, 64hex":        { swapType: "EXACT_INPUT", destinationAsset: nearUsdc?.assetId, amount: "1000000", recipient: hex64 },
  "f arb->USDC near, output, 64hex":       { swapType: "EXACT_OUTPUT", destinationAsset: nearUsdc?.assetId, amount: "1000000", recipient: hex64 },
  "g arb->USDC near, input, 'near'":       { swapType: "EXACT_INPUT", destinationAsset: nearUsdc?.assetId, amount: "1000000", recipient: "near" },
  "h arb->wrap.near, input, 'near'":       { swapType: "EXACT_INPUT", destinationAsset: "nep141:wrap.near", amount: "1000000", recipient: "near" },
};
for (const [k, v] of Object.entries(T)) console.log(k.padEnd(40), await post(v));