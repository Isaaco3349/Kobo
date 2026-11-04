# KOBO: invoices that settle themselves

**Track:** Real-World Money (`realworld`) · **Built for:** NEAR HACKATHON 2026

KOBO lets a freelancer send a normal-looking invoice link. The client pays with whatever token on whatever chain they already hold. The freelancer receives **exactly the invoice amount in USDC on NEAR** and **never buys NEAR for gas**. Every invoice ends with a status you can trust, transaction links, and a CSV an accountant can open without asking a question.

## The problem, in plain words

A freelancer in Lagos invoices a client in Berlin. The client holds ETH, or USDC on Base, or SOL. Today the freelancer must explain wallets, chains and gas, then reconcile whatever arrives. KOBO removes all three steps: the client picks their token, NEAR Intents converts it, the freelancer gets USDC.

## Try it in two minutes

Requires Node 20+. No install step, no keys, no network: the demo has **zero dependencies**.

```sh
git clone <this repo> && cd kobo
npm start                 # open http://localhost:3000
```

| Do this | You will see |
| --- | --- |
| Open the home page | A freelancer account is created in your browser (a NEAR implicit account). It holds **0 NEAR**. |
| Fill in "Get paid" (client, due date, one or more lines) and press **Create invoice link** | An invoice link, copied to your clipboard. The dashboard lists it as **Unpaid**. |
| Open the link (this is the client's view) | The invoice, a countdown to the due date, and "✓ Matches the on-chain record". |
| Pick **ETH**, type any wallet address as refund address, press **Get payment details** | An exact amount to send and a deposit address. |
| Press **Simulate payment** (demo only; it stands in for the client's wallet) | Status goes **In progress**, then **Paid in full**, with a settlement receipt link. |
| Click **view receipt** on the first timeline entry | A receipt showing the freelancer authorised the call and the **relayer paid the gas**. |
| Back on the home page press **Export CSV for your accountant** | One row per invoice, plain-English columns. |

Optional: `npm run seed` fills the app with a paid, an unpaid and an overdue invoice. Start the app, press **Restore** on the home page and choose `data/demo-account.json`.

Press **Simulate failed swap (refund)** instead to see the refund path: the invoice stays unpaid, the refund is recorded, and the client can try again.

## What is real and what is simulated

Honesty first, because the demo has to run anywhere.

| Part | Demo mode (default, what you just ran) | Live mode |
| --- | --- | --- |
| Freelancer account and signatures | **Real.** Ed25519 key in the browser; the public key is the 64-hex NEAR implicit account id. Server verifies every signature. | Same key, real `SignedDelegateAction` (NEP-366) |
| Relayer rules (own contract only, allowlisted methods, nonce, expiry, daily cap) | **Real.** Covered by tests. | Same rules on real transactions |
| Invoice contract | `contract/src/lib.rs` is real Rust with 16 passing tests. Demo mode runs a JS ledger that enforces the **same rules**. | Deployed contract on NEAR testnet |
| NEAR Intents (1Click) | **Simulated** by a deterministic local mock with the same request/response shapes (EXACT_OUTPUT quote, deposit address, status values). | `server/intents.js` `LiveIntents` calls `https://1click.chaindefuser.com` |
| Gas | **Simulated** (a fixed fee is recorded as "paid by the relayer"). | Real gas paid by a funded relayer account |

**Status of live mode:** the live 1Click client is written but not yet exercised against the network, and the live NEAR adapter (real relayer submission, contract deployment, verifier signing) is **not wired yet**: `KOBO_MODE=live` exits with a clear message. This README will be updated the moment it is.

## What the statuses mean

| Status | Meaning |
| --- | --- |
| **Unpaid** | No payment detected. |
| **In progress** | The client's deposit was detected and NEAR Intents is converting it. |
| **Paid** | USDC reached the freelancer. The contract record says `Paid`. The page links to the settlement transaction. |
| **Refunded** | The swap was refunded to the client's wallet. The invoice is still unpaid and can be paid again. |
| **Overdue** | Unpaid or refunded and past the due date. |
| **Cancelled** | The owner cancelled it on-chain. |

## The CSV for your accountant

One row per invoice, UTF-8 with a BOM so Excel opens it correctly, dates in UTC, amounts as plain decimals with no thousands separators. Columns: invoice number, issue date, due date, client, title, line items, invoice total (USDC), status, paid date, amount received (USDC), what the client paid with, amount the client sent, its USD value at quote time, conversion cost (USD), settlement transaction, invoice record transaction, refund transaction, notes. Text that starts with `=`, `+`, `-` or `@` is escaped so a hostile client name cannot run as a spreadsheet formula.

## How "gasless" works

1. The freelancer's browser signs a `create_invoice` call with their own key.
2. The relayer checks it: receiver must be **our contract**, method must be on the allowlist (`create_invoice`, `cancel_invoice`), nonce must be new, expiry must be near, signature must verify, and the account must be under its daily cap.
3. The relayer submits it and pays the fee. The contract sees `predecessor_account_id = freelancer`, never the relayer.

The relayer will not sponsor transfers, swaps, or any other contract.

## How the invoice stays honest

The invoice text lives off-chain. Its SHA-256 (over canonical JSON of the id, owner, client, items, total, due date and note) is signed by the freelancer and stored on-chain as `memo_hash`. The server refuses an invoice whose details do not match the signed hash, and the client's page shows whether the stored details still match the on-chain record.

## Trust assumptions (please read)

* **Cross-chain payments are attested.** When a client pays from another chain, the KOBO backend reads the 1Click status and a `verifier` account records the result on-chain (`attest_payment`). That is a trust assumption in the backend. The contract limits the damage: it can only mark an *open* invoice paid, once, with an amount at least the invoice total.
* **Direct USDC payments on NEAR are trustless.** A client holding USDC on NEAR can `ft_transfer_call` to the contract with the invoice id as `msg`. `ft_on_transfer` checks the token and amount, forwards the money to the owner, and refunds the payer if the forward fails.
* **The demo key lives in browser storage.** Use **Back up key**. Clearing site data without a backup loses the account.
* Prototype limits: `get_invoices_by_owner` is a linear scan; no email delivery; no tax handling.

## Layout

```
server/      zero-dependency Node server: relay, ledger, Intents adapters, invoices, CSV
web/         static UI (no build step); shared money/hash helpers in web/lib.js
contract/    NEAR contract (Rust, near-sdk 5.30) with unit tests
test/        node:test suites
scripts/     seed.js
```

## Tests

```sh
npm test                          # 10 Node tests: money maths, full paid and refund flows,
                                  # relayer rejections, ownership, CSV injection
cd contract && cargo test         # 16 contract tests
```

The UI flow was also driven end to end in headless Chrome (create invoice with browser signing, pay, flip to paid, open receipt) with no console errors.

## Contract

```sh
cd contract
cargo install cargo-near          # once
cargo near build                  # produces the wasm
near contract deploy kobo-invoices.testnet use-file target/near/kobo_invoices.wasm \
  with-init-call new json-args '{"usdc":"<usdc contract>","verifier":"<verifier account>"}' ...
```

Methods: `create_invoice`, `cancel_invoice`, `ft_on_transfer`, `attest_payment`, `attest_refund`, views `get_invoice`, `get_invoices_by_owner`, `get_config`.

## Disclosures

* All code was written during the hackathon window. There is no pre-existing baseline.
* Largely written with AI assistance (Claude), then reviewed and tested.
* Runtime dependencies: none (Node standard library only). Contract: `near-sdk`.
* NEAR features used: NEAR Intents 1Click API (quote, deposit, status), NEP-141 `ft_transfer_call` receiver, NEP-366-style meta transactions, implicit accounts.

## License

MIT
