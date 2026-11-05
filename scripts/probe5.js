const base = "https://1click.chaindefuser.com";
const toks = await (await fetch(base + "/v0/tokens")).json();
const ARB = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
const ev = "0x2527D02599Ba641c19FEa793cD0F167589a0f10D";
const near = toks.filter((t) => t.blockchain === "near");
let ok = 0;
for (const t of near) {
  const r = await fetch(base + "/v0/quote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dry: true, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: ARB, depositType: "ORIGIN_CHAIN", destinationAsset: t.assetId, amount: "5000000", refundTo: ev, refundType: "ORIGIN_CHAIN", recipient: "near", recipientType: "DESTINATION_CHAIN", deadline: new Date(Date.now() + 3600e3).toISOString() }) });
  const body = await r.text();
  if (r.status === 201) { ok++; console.log("OK  ", t.symbol.padEnd(10), t.assetId); }
  else if (!/not available/.test(body)) console.log("OTHER", t.symbol, r.status, body.slice(0, 100));
}
console.log(`${ok} of ${near.length} NEAR-chain tokens can be quoted from USDC on Arbitrum`);