import { DomainError, InvalidTransactionStateError } from './errors';
import { BusinessRuleViolation, FailureCode } from './failure-codes';
import { LedgerDirection } from './ledger-entry';
import type { Money } from './money';

export const WagerTransactionKind = {
  Opening: 'OPENING', // internal: opening credit of a wallet
  Bet: 'BET',
  Win: 'WIN',
  Loss: 'LOSS',
  Refund: 'REFUND',
  Rollback: 'ROLLBACK',
} as const;
export type WagerTransactionKind = typeof WagerTransactionKind[keyof typeof WagerTransactionKind];

/** Kinds a provider may submit. OPENING is internal and never accepted from HTTP or SQS. */
export const externalKinds = [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Loss,
  WagerTransactionKind.Refund, WagerTransactionKind.Rollback] as const;
export type ExternalKind = typeof externalKinds[number];

export const WagerTransactionStatus = {
  Pending: 'PENDING', // accepted, not applied yet
  PendingReference: 'PENDING_REFERENCE', // waiting for the referenced transaction
  Processed: 'PROCESSED', // applied (terminal)
  Rejected: 'REJECTED', // business rule violation (terminal)
  Failed: 'FAILED', // permanent infrastructure error (terminal, auditable)
} as const;
export type WagerTransactionStatus = typeof WagerTransactionStatus[keyof typeof WagerTransactionStatus];

const terminalStatuses: readonly WagerTransactionStatus[] = [WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected, WagerTransactionStatus.Failed];

/** Business fields of a submission; they are exactly the fields covered by `payloadHash`. */
export interface WagerInput {
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  /** Provider-side id of the referenced transaction, not the internal id. */
  referenceExternalTransactionId?: string;
}

export interface CreateWagerTransactionProps extends WagerInput {
  id: string;
  idempotencyKey: string;
  payloadHash: string;
  createdAt?: Date;
}

export interface WagerTransactionState extends WagerInput {
  id: string;
  idempotencyKey: string;
  payloadHash: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
}

/**
 * A provider operation and its lifecycle.
 *
 * Valid transitions:
 *   PENDING           -> PENDING_REFERENCE | PROCESSED | REJECTED | FAILED
 *   PENDING_REFERENCE -> PENDING_REFERENCE (rescheduled) | PROCESSED | REJECTED | FAILED
 * PROCESSED, REJECTED and FAILED are terminal: any further transition throws InvalidTransactionStateError.
 */
export class WagerTransaction {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | undefined;
  readonly createdAt: Date;
  private _status: WagerTransactionStatus;
  private _referenceTransactionId?: string;
  private _failureCode?: FailureCode;
  private _processedAt?: Date;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.createdAt = new Date(state.createdAt);
    this._status = state.status;
    this._referenceTransactionId = state.referenceTransactionId;
    this._failureCode = state.failureCode;
    this._processedAt = state.processedAt && new Date(state.processedAt);
  }

  /** Starts in PENDING. Validates the amount and whether the kind requires or forbids a reference. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.money.isNegative()) throw new DomainError('INVALID_MONEY');
    const reversal = props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    if (reversal && !props.referenceExternalTransactionId) throw new DomainError('REFERENCE_REQUIRED');
    if (!reversal && props.kind !== WagerTransactionKind.Win && props.referenceExternalTransactionId) {
      throw new DomainError('REFERENCE_NOT_ALLOWED');
    }
    if (props.referenceExternalTransactionId === props.externalTransactionId) throw new DomainError('SELF_REFERENCE');
    return new WagerTransaction({ ...props, createdAt: props.createdAt ?? new Date(),
      status: WagerTransactionStatus.Pending });
  }

  /** Rebuilds persisted state without revalidating transitions. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get status(): WagerTransactionStatus { return this._status; }
  get referenceTransactionId(): string | undefined { return this._referenceTransactionId; }
  get failureCode(): FailureCode | undefined { return this._failureCode; }
  get processedAt(): Date | undefined { return this._processedAt; }

  // ---- transitions

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.transition(WagerTransactionStatus.Processed);
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
  }

  markPendingReference(): void {
    this.transition(WagerTransactionStatus.PendingReference);
  }

  reject(code: FailureCode): void {
    this.transition(WagerTransactionStatus.Rejected);
    this._failureCode = code;
  }

  fail(code: FailureCode): void {
    this.transition(WagerTransactionStatus.Failed);
    this._failureCode = code;
  }

  // ---- domain queries

  isTerminal(): boolean { return terminalStatuses.includes(this._status); }
  affectsBalance(): boolean { return this.kind !== WagerTransactionKind.Loss; }
  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }
  matchesPayload(payloadHash: string): boolean { return this.payloadHash === payloadHash; }

  /**
   * Checks the referenced transaction: same provider, wallet, player, round and currency; an allowed kind;
   * the same amount for reversals; and PROCESSED status. Throws BusinessRuleViolation with the matching code.
   * Without a reference, it fails only when this transaction names one.
   */
  assertReference(reference?: WagerTransaction): void {
    if (!reference) {
      if (this.referenceExternalTransactionId) throw new BusinessRuleViolation(FailureCode.ReferenceNotProcessed);
      return;
    }
    if (this.providerId !== reference.providerId || this.walletId !== reference.walletId ||
        this.playerId !== reference.playerId || this.roundId !== reference.roundId ||
        this.money.currency !== reference.money.currency) {
      throw new BusinessRuleViolation(FailureCode.ReferenceScopeMismatch);
    }
    const allowed: readonly WagerTransactionKind[] = this.kind === WagerTransactionKind.Rollback
      ? [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund]
      : [WagerTransactionKind.Bet];
    if (!allowed.includes(reference.kind)) throw new BusinessRuleViolation(FailureCode.InvalidReferenceKind);
    if (this.requiresReference() && !this.money.equals(reference.money)) {
      throw new BusinessRuleViolation(FailureCode.ReferenceAmountMismatch);
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
      throw new BusinessRuleViolation(FailureCode.ReferenceNotProcessed);
    }
  }

  /** Direction of the ledger entry this transaction produces. ROLLBACK inverts its reference. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback:
        if (!reference) throw new Error('ROLLBACK needs its reference to choose a direction');
        return reference.kind === WagerTransactionKind.Bet ? LedgerDirection.Credit : LedgerDirection.Debit;
      case WagerTransactionKind.Loss:
        throw new Error('LOSS does not affect the balance');
    }
  }

  /** The business fields, as hashed for idempotency. */
  toInput(): WagerInput {
    return { providerId: this.providerId, externalTransactionId: this.externalTransactionId,
      walletId: this.walletId, playerId: this.playerId, roundId: this.roundId, gameId: this.gameId,
      kind: this.kind, money: this.money, referenceExternalTransactionId: this.referenceExternalTransactionId };
  }

  toState(): WagerTransactionState {
    return { ...this.toInput(), id: this.id, idempotencyKey: this.idempotencyKey, payloadHash: this.payloadHash,
      createdAt: this.createdAt, status: this._status, referenceTransactionId: this._referenceTransactionId,
      failureCode: this._failureCode, processedAt: this._processedAt };
  }

  private transition(to: WagerTransactionStatus): void {
    if (this.isTerminal()) throw new InvalidTransactionStateError(this.id, this._status, to);
    this._status = to;
  }
}
