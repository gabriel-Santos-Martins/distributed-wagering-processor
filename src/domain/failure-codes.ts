import { DomainError } from './errors';

/** Stable, machine-readable reasons carried by REJECTED and FAILED transactions. */
export const FailureCode = {
  InsufficientFunds: 'INSUFFICIENT_FUNDS',
  ReversalInsufficientFunds: 'REVERSAL_INSUFFICIENT_FUNDS',
  AlreadyReversed: 'ALREADY_REVERSED',
  ReferenceExpired: 'REFERENCE_EXPIRED',
  ReferenceNotProcessed: 'REFERENCE_NOT_PROCESSED',
  ReferenceScopeMismatch: 'REFERENCE_SCOPE_MISMATCH',
  InvalidReferenceKind: 'INVALID_REFERENCE_KIND',
  ReferenceAmountMismatch: 'REFERENCE_AMOUNT_MISMATCH',
  AmountLimit: 'AMOUNT_LIMIT',
  PermanentPersistenceError: 'PERMANENT_PERSISTENCE_ERROR',
} as const;
export type FailureCode = typeof FailureCode[keyof typeof FailureCode];

/** A business rule ended the transaction. The use case records it as REJECTED with this code. */
export class BusinessRuleViolation extends DomainError {
  constructor(override readonly code: FailureCode) {
    super(code, 422);
    this.name = 'BusinessRuleViolation';
  }
}
