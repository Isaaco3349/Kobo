# Going live on NEAR

Demo mode needs nothing. Live mode uses the real NEAR RPC, the real 1Click API, a deployed contract and two funded accounts. Run `npm run doctor` after any step; it names exactly what is still wrong.

## Which network?

NEAR Intents has **no testnet**. The invoice contract and relayer work on testnet, but a real cross-chain payment only exists on **mainnet**. Recommended plan:

1. Rehearse on **testnet** (`NEAR_NETWORK=testnet`): account creation, gasless create/cancel, contract rules. Intents `dry` quotes work from anywhere.
2. Do the final demo on **mainnet** (`NEAR_NETWORK=mainnet`) with a tiny invoice (1 to 2 USDC). The relayer needs a few NEAR; everything else is the same.

## 1. Two keys

```sh
npm run keygen     # run twice: one for the relayer, one for the verifier
```

Each run prints a public key, a private key (`ed25519:...`) and an implicit account id.

## 2. Two accounts

Easiest is to use the implicit accounts keygen printed (the 64-hex id **is** the account; no creation step). Fund each by sending NEAR to that address:

| Account | Role | Needs |
| --- | --- | --- |
| relayer | pays gas, creates each freelancer's account, registers it for USDC | about 0.5 NEAR to start (each new freelancer costs about 0.012 NEAR: 0.01 sent to their account for withdrawal fees, plus USDC registration) |
| verifier | records payments on the contract | 0.05 NEAR |

Testnet NEAR is free from a faucet. If you prefer named accounts (`kobo-relayer.near`), create them in any NEAR wallet and use their key.

## 3. Deploy the contract

```sh
cargo install cargo-near            # once; also install near-cli-rs from near.org docs
cd contract
cargo near build non-reproducible-wasm
```

Deploy to an account you own (a contract account that is **not** the relayer or verifier), initialising it with the USDC token and your verifier account. Command shape from near-cli-rs (run `near contract deploy --help` if flags differ in your version):

```sh
near contract deploy YOUR-CONTRACT.near use-file target/near/kobo_invoices.wasm \
  with-init-call new json-args '{"usdc":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","verifier":"YOUR-VERIFIER-ACCOUNT"}' \
  prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config mainnet sign-with-keychain send
```

On testnet use any testnet USDC-like token for `usdc` (it only matters for the trustless direct-payment path).

Then register the contract with the USDC token so direct payments can be forwarded (one time):

```sh
near contract call-function as-transaction 17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1 storage_deposit json-args '{"account_id":"YOUR-CONTRACT.near","registration_only":true}' prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' sign-as YOUR-ACCOUNT network-config mainnet sign-with-keychain send
```

## 4. Configure

```sh
cp .env.example .env     # Windows PowerShell: Copy-Item .env.example .env
```

Fill in `NEAR_NETWORK`, `KOBO_CONTRACT`, `RELAYER_ACCOUNT_ID`, `RELAYER_PRIVATE_KEY`, `VERIFIER_ACCOUNT_ID`, `VERIFIER_PRIVATE_KEY`. Never commit `.env` (it is git-ignored).

## 5. Check, then run

```sh
npm run doctor     # every line should be a tick
npm start          # "Live mode on NEAR mainnet: contract ..., relayer ..."
```

## 6. One real payment (mainnet, about 1 USDC)

1. Open the app, create a 1 USDC invoice. The first time takes a few seconds: the relayer creates your account and registers it for USDC.
2. Open the invoice link, choose a token you hold (say USDC on Base), enter your own wallet as the refund address, get the payment details.
3. Send the exact amount shown from your wallet to the deposit address. Optionally paste the transaction hash.
4. The page moves to *In progress*, then *Paid*, with explorer links. The USDC arrives at the freelancer account.
5. Export the CSV.

Record this for the demo video. If the swap fails or times out, the funds go back to your refund address and the invoice shows *Refunded*.

## What can go wrong

| Symptom | Cause |
| --- | --- |
| `Live mode needs these settings` | a required `.env` value is missing |
| doctor: "key is not an access key of ..." | the private key does not belong to that account |
| "Account is not set up yet" | the relayer has too little NEAR to create accounts; fund it |
| Invoice stays *Unpaid* after sending | wrong token or chain, or amount below the quote; check the deposit address and amount, paste the tx hash |
| Contract rejected: "Only the verifier can attest" | contract was initialised with a different verifier than `VERIFIER_ACCOUNT_ID` |
