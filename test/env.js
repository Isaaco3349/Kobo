// Imported FIRST by every test that touches the server config. Tests must never read the developer's
// real `.env` or talk to a real network: a live/mainnet .env would otherwise make tests spend real NEAR.
// (server/config.js lets real environment variables win over .env, and an empty value counts as unset.)
Object.assign(process.env, {
  KOBO_MODE: "demo",
  NEAR_NETWORK: "testnet",
  KOBO_CONTRACT: "kobo-invoices.testnet",
  VERIFIER_ACCOUNT_ID: "kobo-verifier.testnet",
  RELAYER_ACCOUNT_ID: "",
  RELAYER_PRIVATE_KEY: "",
  VERIFIER_PRIVATE_KEY: "",
  USDC_CONTRACT: "",
  ONECLICK_JWT: "",
  KOBO_DB: "",
});
