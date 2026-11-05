const base = "https://1click.chaindefuser.com";
const key = process.env.ONECLICK_JWT || "";
const post = async (body, withKey) => {
  const h = { "Content-Type": "application/json" };
  if (key && withKey) { h["X-API-Key"] = key; }
  const r = await fetch(base + "/v0/quote", { method: "POST", headers: h, body: JSON.stringify(body) });
  return r.status + " " + (await r.text()).replace(/\s+/g, " ").slice(0, 170);
};
const doc = () => ({
  dry: true, swapType: "EXACT_INPUT", slippageTolerance: 100,
  originAsset: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
  depositType: "ORIGIN_CHAIN",
  destinationAsset: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
  amount: "1000000", refundTo: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D", refundType: "ORIGIN_CHAIN",
  recipient: "13QkxhNMrTPxoCkRdYdJ65tFuwXPhL5gLS2Z5Nr6gjRK", recipientType: "DESTINATION_CHAIN",
  deadline: new Date(Date.now() + 3600e3).toISOString(),
});
console.log("key present:", !!key);
console.log("official example, no key        ", await post(doc(), false));
console.log("official example, with key      ", await post(doc(), true));
console.log("official example, waiting 8s    ", await post({ ...doc(), quoteWaitingTimeMs: 8000 }, true));
console.log("official example, bigger 100 USDC", await post({ ...doc(), amount: "100000000" }, true));
const h = await fetch(base + "/v0/tokens"); console.log("tokens endpoint:", h.status);