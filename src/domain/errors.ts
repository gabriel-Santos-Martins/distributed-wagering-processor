/** Expected rejection of an input or a request, carrying a stable code and the HTTP status that represents it. */
export class DomainError extends Error {
  constructor(readonly code: string, readonly httpStatus = 400) {
    super(code);
    this.name = 'DomainError';
  }
}

/**
 * Programming error: a transaction in a terminal state was asked to change state.
 * It is never a business outcome, so the use case does not turn it into a rejection.
 */
export class InvalidTransactionStateError extends Error {
  constructor(readonly transactionId: string, readonly from: string, readonly to: string) {
    super(`Transaction ${transactionId} cannot move from ${from} to ${to}`);
    this.name = 'InvalidTransactionStateError';
  }
}
