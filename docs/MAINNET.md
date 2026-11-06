# Mainnet runbook (real payment)

Self-contained: follow it top to bottom. Run commands in PowerShell from the `kobo` folder.
The NEAR CLI is interactive, so it will ask for choices; the values to type are given below.

Budget: about 2.2 NEAR. About 1.55 of it is locked as storage for the contract and comes back if you delete the account.
Test payment: a 1.00 USDC invoice; the client pays about 1.01 USDC. Hold about 1.5 USDC plus a few cents of ETH on Arbitrum or Base.

## 0. Accounts you will use

* `FUND`  the account you fund from Bybit (implicit, key saved by the CLI).
* `kobo-isaac-ops.near`  the operator: relayer AND verifier in one account with one key.
* `kobo-isaac-app.near`  the contract account.

(Names must be free on mainnet; add a suffix if the CLI says it exists.)

## 1. Fund

```powershell
near account create-account fund-later use-auto-generation save-to-folder $HOME\.near-credentials\implicit
```

Send about 2.2 NEAR from Bybit to the printed address (network: NEAR). Check:

```powershell
near account view-account-summary <FUND-ADDRESS> network-config mainnet now
```

## 2. Create the two named accounts from FUND

Contract account (fund it with 1.7 NEAR) and operator account (0.4 NEAR). Use:

```powershell
near account create-account fund-myself kobo-isaac-app.near '1.7 NEAR' autogenerate-new-keypair save-to-keychain sign-as 4495ff5fe7165cc5164fe0011210e292de96e6fce38cbf893c28efda7363ee8b network-config mainnet sign-with-access-key-file 'C:\Users\user\.near-credentials\implicit\4495ff5fe7165cc5164fe0011210e292de96e6fce38cbf893c28efda7363ee8b.json' send

near account create-account fund-myself kobo-isaac-ops.near '0.4 NEAR' autogenerate-new-keypair save-to-keychain sign-as 4495ff5fe7165cc5164fe0011210e292de96e6fce38cbf893c28efda7363ee8b network-config mainnet sign-with-access-key-file 'C:\Users\user\.near-credentials\implicit\4495ff5fe7165cc5164fe0011210e292de96e6fce38cbf893c28efda7363ee8b.json' send
```

If the CLI asks questions instead, answer: sign as FUND, new keypair, save to keychain, network mainnet, sign with access key file.

## 3. Deploy the contract (wasm already built: `contract\kobo_invoices.wasm`)

```powershell
near contract deploy kobo-isaac-app.near use-file contract\kobo_invoices.wasm with-init-call new json-args '{"usdc":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","verifier":"kobo-isaac-ops.near"}' prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' network-config mainnet sign-with-keychain send
```

Register the contract to receive USDC (needed for the trustless direct-USDC path):

```powershell
near contract call-function as-transaction 17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1 storage_deposit json-args '{"account_id":"kobo-isaac-app.near","registration_only":true}' prepaid-gas '30.0 Tgas' attached-deposit '0.00125 NEAR' sign-as kobo-isaac-ops.near network-config mainnet sign-with-keychain send
```

## 4. Export the operator key

```powershell
near account export-account kobo-isaac-ops.near using-private-key network-config mainnet
```

(Or find it in `$HOME\.near-credentials\mainnet\kobo-isaac-ops.near\`.) Copy the `ed25519:...` private key.
Never commit it; `.env` is git-ignored.

## 5. `.env` for mainnet

```
KOBO_MODE=live
NEAR_NETWORK=mainnet
KOBO_CONTRACT=kobo-isaac-app.near
RELAYER_ACCOUNT_ID=kobo-isaac-ops.near
RELAYER_PRIVATE_KEY=ed25519:...        # the operator key
VERIFIER_ACCOUNT_ID=kobo-isaac-ops.near
VERIFIER_PRIVATE_KEY=ed25519:...       # the same key
ONECLICK_JWT=...                       # keep your existing key
```

Remove any `USDC_CONTRACT=` line (mainnet defaults to the real USDC).

```powershell
npm run doctor
```

Expect all checks to pass: contract deployed, verifier matches, contract registered with USDC, payment routes with a tick.

## 6. Rehearse the real payment (no recording)

1. `npm start`, open http://localhost:3000, create a 1.00 USDC invoice, open the link.
2. Choose USDC on Arbitrum or Base. Refund address: your OWN EVM wallet address.
3. Press Get payment details. Send exactly the amount shown, to the address shown, from your EVM wallet, on that chain only.
4. Wait. The page goes In progress, then Paid with a transaction link. Check the freelancer account on https://nearblocks.io holds the USDC.

If the page stays In progress for more than 15 minutes, look at the terminal for lines starting with `poll`.

## 7. If a withdrawal failed (USDC is not lost)

The swap output waits in the operator's balance inside `intents.near`. KOBO retries on its next poll. To do it by hand
(replace RECEIVER with the freelancer account id and AMOUNT in USDC units, 1000000 = 1 USDC):

```powershell
near contract call-function as-transaction intents.near ft_withdraw json-args '{"token":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","receiver_id":"RECEIVER","amount":"1000000"}' prepaid-gas '100.0 Tgas' attached-deposit '1 yoctoNEAR' sign-as kobo-isaac-ops.near network-config mainnet sign-with-keychain send
```

## 8. Get your money back afterwards

* USDC received: on the home page press Export for NEAR wallet, import that key into a NEAR wallet, send or swap the USDC.
* Unused NEAR in the operator account: send it back to FUND.
* Contract storage (about 1.55 NEAR): delete the contract account to return it:
  `near account delete-account kobo-isaac-app.near beneficiary <FUND-ADDRESS> network-config mainnet sign-with-keychain send`
  (Do this only after the hackathon judging, because the demo links need the contract.)

## 9. After a real payment works

Update the README line "has not yet been run against the real network" with the real transaction links, record the video, post on X
(tag @NEARProtocol, #NEARHackathon), then submit. Deadline: Sat 14 Nov 23:59 UTC (00:59 Sun 15 Nov in Lagos).

## Appendix: "Link Error: unknown or invalid import" on deploy

The newest near-sdk (5.30) links host functions that mainnet does not have yet (gas keys, universal state init). The contract is
pinned to `near-sdk = "=5.20.1"`, which does not. Rebuild in WSL after changing it:

```
cd /mnt/c/Users/user/projects/kobo/contract
cargo near build non-reproducible-wasm
```

Copy `contract\target\near\kobo_invoices.wasm` over `contract\kobo_invoices.wasm`, then check the imports contain no `gas_key` and
no `universal_state_init`:

```powershell
node -e "const fs=require('fs');const m=new WebAssembly.Module(fs.readFileSync('contract/kobo_invoices.wasm'));console.log(WebAssembly.Module.imports(m).map(i=>i.name).join(' '))"
```
