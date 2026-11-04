//! KOBO invoice registry.
//!
//! * A freelancer records an invoice. The call is normally a NEP-366 meta transaction, so the
//!   relayer pays gas, and `predecessor_account_id` is the freelancer (never the relayer).
//! * Two ways an invoice becomes paid:
//!   1. TRUSTLESS: the client sends USDC on NEAR with `ft_transfer_call` and `msg = <invoice id>`.
//!      `ft_on_transfer` verifies the token and amount, then forwards the USDC to the owner.
//!      If the forward fails, the invoice reopens and the payer is refunded.
//!   2. ATTESTED: the client pays from another chain through NEAR Intents (1Click). A `verifier`
//!      account (the Kobo backend) reads the swap status and records the result with
//!      `attest_payment` / `attest_refund`. This path trusts the verifier; see README.
//! * Off-chain invoice details are committed to by `memo_hash` (sha256 of canonical JSON), so
//!   anyone can check that the details a client sees are the ones the freelancer signed.

use near_sdk::json_types::U128;
use near_sdk::store::IterableMap;
use near_sdk::{
    env, ext_contract, near, require, AccountId, Gas, NearToken, PanicOnDefault, PromiseError, PromiseOrValue,
};

const FORWARD_GAS: Gas = Gas::from_tgas(15);
const CALLBACK_GAS: Gas = Gas::from_tgas(10);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

#[ext_contract(ext_ft)]
pub trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Status {
    Open,
    Paid,
    Cancelled,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Invoice {
    pub owner: AccountId,
    pub amount: U128,
    pub due_ms: u64,
    pub memo_hash: String,
    pub status: Status,
    pub created_ms: u64,
    pub paid_ms: Option<u64>,
    pub source_tx: Option<String>,
    pub refunds: u32,
    pub last_refund_tx: Option<String>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Kobo {
    usdc: AccountId,
    verifier: AccountId,
    invoices: IterableMap<String, Invoice>,
}

fn valid_id(id: &str) -> bool {
    let b = id.as_bytes();
    b.len() == 9
        && b[4] == b'-'
        && b.iter().enumerate().all(|(i, c)| i == 4 || c.is_ascii_uppercase() || c.is_ascii_digit())
}

fn valid_hash(h: &str) -> bool {
    h.len() == 64 && h.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

#[near]
impl Kobo {
    #[init]
    pub fn new(usdc: AccountId, verifier: AccountId) -> Self {
        Self { usdc, verifier, invoices: IterableMap::new(b"i") }
    }

    // ---------------------------------------------------------------- owner calls
    /// The caller (the freelancer, even when relayed) becomes the invoice owner.
    pub fn create_invoice(&mut self, id: String, amount: U128, due_ms: u64, memo_hash: String) {
        require!(valid_id(&id), "Invoice id must look like ABCD-1234");
        require!(amount.0 > 0, "Amount must be greater than zero");
        require!(valid_hash(&memo_hash), "memo_hash must be 64 lowercase hex characters");
        require!(due_ms > 0, "Bad due date");
        require!(!self.invoices.contains_key(&id), "Invoice id already exists");
        self.invoices.insert(
            id,
            Invoice {
                owner: env::predecessor_account_id(),
                amount,
                due_ms,
                memo_hash,
                status: Status::Open,
                created_ms: env::block_timestamp_ms(),
                paid_ms: None,
                source_tx: None,
                refunds: 0,
                last_refund_tx: None,
            },
        );
    }

    pub fn cancel_invoice(&mut self, id: String) {
        let who = env::predecessor_account_id();
        let inv = self.invoices.get_mut(&id).unwrap_or_else(|| env::panic_str("No such invoice"));
        require!(inv.owner == who, "Only the invoice owner can cancel");
        require!(inv.status == Status::Open, "Only an open invoice can be cancelled");
        inv.status = Status::Cancelled;
    }

    // ---------------------------------------------------------------- trustless path
    /// NEP-141 receiver. `msg` is the invoice id.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.usdc, "Only USDC payments are accepted");
        let inv = self.invoices.get_mut(&msg).unwrap_or_else(|| env::panic_str("No such invoice"));
        require!(inv.status == Status::Open, "Invoice is not open");
        require!(amount.0 >= inv.amount.0, "Amount is below the invoice total");
        inv.status = Status::Paid;
        inv.paid_ms = Some(env::block_timestamp_ms());
        inv.source_tx = Some(format!("ft_transfer_call from {}", sender_id));
        let owner = inv.owner.clone();
        ext_ft::ext(self.usdc.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(FORWARD_GAS)
            .ft_transfer(owner, amount, Some(format!("KOBO invoice {}", msg)))
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_forwarded(msg, amount))
            .into()
    }

    /// If forwarding to the owner failed (e.g. owner not registered with USDC), reopen the
    /// invoice and report the whole amount as unused so the USDC contract refunds the payer.
    #[private]
    pub fn on_forwarded(&mut self, id: String, paid: U128, #[callback_result] result: Result<(), PromiseError>) -> U128 {
        match result {
            Ok(()) => U128(0),
            Err(_) => {
                if let Some(inv) = self.invoices.get_mut(&id) {
                    inv.status = Status::Open;
                    inv.paid_ms = None;
                    inv.source_tx = None;
                }
                paid
            }
        }
    }

    // ---------------------------------------------------------------- attested path (Intents)
    pub fn attest_payment(&mut self, id: String, received: U128, source_tx: String) {
        self.only_verifier();
        let inv = self.invoices.get_mut(&id).unwrap_or_else(|| env::panic_str("No such invoice"));
        require!(inv.status != Status::Paid, "Invoice already paid");
        require!(inv.status == Status::Open, "Invoice is not open");
        require!(received.0 >= inv.amount.0, "Received amount is below the invoice amount");
        inv.status = Status::Paid;
        inv.paid_ms = Some(env::block_timestamp_ms());
        inv.source_tx = Some(source_tx);
    }

    /// A swap was refunded to the client. The invoice stays open; we keep the audit trail.
    pub fn attest_refund(&mut self, id: String, refund_tx: String) {
        self.only_verifier();
        let inv = self.invoices.get_mut(&id).unwrap_or_else(|| env::panic_str("No such invoice"));
        require!(inv.status == Status::Open, "Invoice is not open");
        inv.refunds += 1;
        inv.last_refund_tx = Some(refund_tx);
    }

    // ---------------------------------------------------------------- views
    pub fn get_invoice(&self, id: String) -> Option<Invoice> {
        self.invoices.get(&id).cloned()
    }

    /// Linear scan; fine for a prototype. A production version would index by owner.
    pub fn get_invoices_by_owner(&self, owner: AccountId, from_index: u32, limit: u32) -> Vec<(String, Invoice)> {
        self.invoices
            .iter()
            .filter(|(_, v)| v.owner == owner)
            .skip(from_index as usize)
            .take(limit as usize)
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    pub fn get_config(&self) -> (AccountId, AccountId) {
        (self.usdc.clone(), self.verifier.clone())
    }

    fn only_verifier(&self) {
        require!(env::predecessor_account_id() == self.verifier, "Only the verifier can attest");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    const HASH: &str = "f7e37eb3c1d2a9b8e4f50617283940a1b2c3d4e5f60718293a4b5c6d7e8f9012";

    fn ctx(who: AccountId) {
        testing_env!(VMContextBuilder::new().predecessor_account_id(who).block_timestamp(1_700_000_000_000_000_000).build());
    }
    // accounts(0)=alice(freelancer) 1=bob(stranger) 2=charlie(verifier) 3=danny(usdc)
    fn setup() -> Kobo {
        ctx(accounts(0));
        let mut c = Kobo::new(accounts(3), accounts(2));
        c.create_invoice("K7QM-2XPD".into(), U128(850_000_000), 4_102_444_800_000, HASH.into());
        c
    }

    #[test]
    fn create_records_predecessor_as_owner() {
        let c = setup();
        let inv = c.get_invoice("K7QM-2XPD".into()).unwrap();
        assert_eq!(inv.owner, accounts(0));
        assert_eq!(inv.status, Status::Open);
        assert_eq!(inv.created_ms, 1_700_000_000_000);
    }

    #[test]
    #[should_panic(expected = "Invoice id already exists")]
    fn duplicate_id_rejected() {
        let mut c = setup();
        c.create_invoice("K7QM-2XPD".into(), U128(1), 1, HASH.into());
    }

    #[test]
    #[should_panic(expected = "Invoice id must look like")]
    fn bad_id_rejected() {
        ctx(accounts(0));
        let mut c = Kobo::new(accounts(3), accounts(2));
        c.create_invoice("lowercase".into(), U128(1), 1, HASH.into());
    }

    #[test]
    #[should_panic(expected = "memo_hash must be")]
    fn bad_hash_rejected() {
        ctx(accounts(0));
        let mut c = Kobo::new(accounts(3), accounts(2));
        c.create_invoice("AAAA-BBBB".into(), U128(1), 1, "nothex".into());
    }

    #[test]
    fn owner_can_cancel_stranger_cannot() {
        let mut c = setup();
        ctx(accounts(0));
        c.cancel_invoice("K7QM-2XPD".into());
        assert_eq!(c.get_invoice("K7QM-2XPD".into()).unwrap().status, Status::Cancelled);
    }

    #[test]
    #[should_panic(expected = "Only the invoice owner can cancel")]
    fn stranger_cannot_cancel() {
        let mut c = setup();
        ctx(accounts(1));
        c.cancel_invoice("K7QM-2XPD".into());
    }

    #[test]
    fn verifier_attests_payment_once() {
        let mut c = setup();
        ctx(accounts(2));
        c.attest_payment("K7QM-2XPD".into(), U128(850_000_000), "settle-tx".into());
        let inv = c.get_invoice("K7QM-2XPD".into()).unwrap();
        assert_eq!(inv.status, Status::Paid);
        assert_eq!(inv.source_tx.as_deref(), Some("settle-tx"));
    }

    #[test]
    #[should_panic(expected = "Invoice already paid")]
    fn double_payment_rejected() {
        let mut c = setup();
        ctx(accounts(2));
        c.attest_payment("K7QM-2XPD".into(), U128(850_000_000), "a".into());
        c.attest_payment("K7QM-2XPD".into(), U128(850_000_000), "b".into());
    }

    #[test]
    #[should_panic(expected = "Only the verifier can attest")]
    fn only_verifier_attests() {
        let mut c = setup();
        ctx(accounts(1));
        c.attest_payment("K7QM-2XPD".into(), U128(850_000_000), "x".into());
    }

    #[test]
    #[should_panic(expected = "below the invoice amount")]
    fn underpayment_rejected() {
        let mut c = setup();
        ctx(accounts(2));
        c.attest_payment("K7QM-2XPD".into(), U128(849_999_999), "x".into());
    }

    #[test]
    fn refund_keeps_invoice_open_and_counts() {
        let mut c = setup();
        ctx(accounts(2));
        c.attest_refund("K7QM-2XPD".into(), "refund-tx".into());
        let inv = c.get_invoice("K7QM-2XPD".into()).unwrap();
        assert_eq!(inv.status, Status::Open);
        assert_eq!(inv.refunds, 1);
    }

    #[test]
    fn trustless_usdc_payment_marks_paid() {
        let mut c = setup();
        ctx(accounts(3)); // the USDC contract calls ft_on_transfer
        let _ = c.ft_on_transfer(accounts(1), U128(850_000_000), "K7QM-2XPD".into());
        assert_eq!(c.get_invoice("K7QM-2XPD".into()).unwrap().status, Status::Paid);
    }

    #[test]
    #[should_panic(expected = "Only USDC payments are accepted")]
    fn wrong_token_rejected() {
        let mut c = setup();
        ctx(accounts(1));
        let _ = c.ft_on_transfer(accounts(1), U128(850_000_000), "K7QM-2XPD".into());
    }

    #[test]
    #[should_panic(expected = "Amount is below the invoice total")]
    fn trustless_underpayment_rejected() {
        let mut c = setup();
        ctx(accounts(3));
        let _ = c.ft_on_transfer(accounts(1), U128(1), "K7QM-2XPD".into());
    }

    #[test]
    fn failed_forward_reopens_invoice_and_refunds_payer() {
        let mut c = setup();
        ctx(accounts(3));
        let _ = c.ft_on_transfer(accounts(1), U128(850_000_000), "K7QM-2XPD".into());
        testing_env!(
            VMContextBuilder::new().current_account_id(accounts(4)).predecessor_account_id(accounts(4)).build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![near_sdk::PromiseResult::Failed]
        );
        let unused = c.on_forwarded("K7QM-2XPD".into(), U128(850_000_000), Err(PromiseError::Failed));
        assert_eq!(unused.0, 850_000_000);
        assert_eq!(c.get_invoice("K7QM-2XPD".into()).unwrap().status, Status::Open);
    }

    #[test]
    fn list_by_owner() {
        let c = setup();
        assert_eq!(c.get_invoices_by_owner(accounts(0), 0, 10).len(), 1);
        assert_eq!(c.get_invoices_by_owner(accounts(1), 0, 10).len(), 0);
    }
}
