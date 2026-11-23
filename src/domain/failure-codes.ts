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
  CurrencyMismatch: 'CURRENCY_MISMATCH',
  PlayerWalletMismatch: 'PLAYER_WALLET_MISMATCH',
  PermanentPersistenceError: 'PERMANENT_PERSISTENCE_ERROR',
} as const;
export type FailureCode = typeof FailureCode[keyof typeof FailureCode];

/**
 * What a provider should do after a rejection. Resubmitting the same idempotency key always replays the
 * original result, so FIX_AND_RESUBMIT and RESUBMIT_AFTER_REFERENCE mean a new externalTransactionId and key.
 */
export const FailureAction = {
  DoNotRetry: 'DO_NOT_RETRY',
  FixAndResubmit: 'FIX_AND_RESUBMIT',
  ResubmitAfterReference: 'RESUBMIT_AFTER_REFERENCE',
  ContactOperator: 'CONTACT_OPERATOR',
} as const;
export type FailureAction = typeof FailureAction[keyof typeof FailureAction];

const actions: Readonly<Record<FailureCode, FailureAction>> = {
  INSUFFICIENT_FUNDS: FailureAction.DoNotRetry,
  REVERSAL_INSUFFICIENT_FUNDS: FailureAction.ContactOperator,
  ALREADY_REVERSED: FailureAction.DoNotRetry,
  REFERENCE_EXPIRED: FailureAction.ResubmitAfterReference,
  REFERENCE_NOT_PROCESSED: FailureAction.DoNotRetry,
  REFERENCE_SCOPE_MISMATCH: FailureAction.FixAndResubmit,
  INVALID_REFERENCE_KIND: FailureAction.FixAndResubmit,
  REFERENCE_AMOUNT_MISMATCH: FailureAction.FixAndResubmit,
  AMOUNT_LIMIT: FailureAction.DoNotRetry,
  CURRENCY_MISMATCH: FailureAction.FixAndResubmit,
  PLAYER_WALLET_MISMATCH: FailureAction.FixAndResubmit,
  PERMANENT_PERSISTENCE_ERROR: FailureAction.ContactOperator,
};

export function failureActionFor(code: FailureCode): FailureAction {
  return actions[code];
}

/** A business rule ended the transaction. The use case records it as REJECTED with this code. */
export class BusinessRuleViolation extends DomainError {
  constructor(override readonly code: FailureCode) {
    super(code, 422);
    this.name = 'BusinessRuleViolation';
  }
}
