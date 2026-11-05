const base = "https://1click.chaindefuser.com";
const toks = await (await fetch(base + "/v0/tokens")).json();
const nearUsdc = toks.find((t) => t.symbol === "USDC" && t.blockchain === "near").assetId;
const ARB = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
const ev = "0x2527D02599Ba641c19FEa793cD0F167589a0f10D";
const hex64 = "a".repeat(64);
const post = async (b) => {
  const r = await fetch(base + "/v0/quote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dry: true, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: ARB, depositType: "ORIGIN_CHAIN", destinationAsset: nearUsdc, amount: "5000000", refundTo: ev, refundType: "ORIGIN_CHAIN", deadline: new Date(Date.now() + 3600e3).toISOString(), ...b }) });
  const t = await r.text(); return r.status + " " + (r.status === 201 ? "OK quote " + (JSON.parse(t).quote?.amountOutFormatted || "") : t.replace(/\s+/g, " ").slice(0, 110));
};
const T = {
  "a recipientType INTENTS, 'near'":       { recipientType: "INTENTS", recipient: "near" },
  "b recipientType INTENTS, 64-hex":       { recipientType: "INTENTS", recipient: hex64 },
  "c INTENTS + 'near.near'":               { recipientType: "INTENTS", recipient: "intents.near" },
  "d DESTINATION_CHAIN, 'wrap.near'":      { recipientType: "DESTINATION_CHAIN", recipient: "wrap.near" },
  "e DESTINATION_CHAIN, kobo testnet acct":{ recipientType: "DESTINATION_CHAIN", recipient: "kobo-isaac-r.testnet" },
};
for (const [k, v] of Object.entries(T)) console.log(k.padEnd(42), await post(v));