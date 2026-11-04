export class ApiError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Relayer refused or the contract rejected a relayed call. */
export class RelayError extends ApiError {}

/** A contract call failed on-chain (or in the demo ledger). `tx` carries the receipt when known. */
export class ChainError extends Error {}
