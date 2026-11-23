import { randomUUID } from 'node:crypto';
import { BusinessRuleViolation, FailureCode, LedgerDirection, OutboxMessage, Wallet, WalletBalanceChanged,
  WagerTransaction, WagerTransactionKind, WagerTransactionPendingReference, WagerTransactionProcessed,
  WagerTransactionRejected, WagerTransactionStatus, type IntegrationEvent, type Money,
  type WalletLedgerEntry } from '../domain';
import type { TransactionScope, UnitOfWork } from './ports';

/** Scheduled attempts for a missing reference before REFERENCE_EXPIRED. */
export const maxReferenceAttempts = 10;
/** Backoff between reference attempts: 1, 2, 4 ... seconds, capped here. */
const maxReferenceDelaySeconds = 60;

export interface AppliedTransaction {
  transaction: WagerTransaction;
  balance: Money;
}

/**
 * Applies a persisted transaction to its locked wallet. Shared by the first submission (HTTP and SQS)
 * and by the pending-reference worker, so every path follows the same rules.
 */
export class TransactionProcessor {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  /**
   * Runs the financial attempt in a savepoint. A deterministic write failure undoes balance, ledger and
   * outbox of the attempt, and the transaction is recorded as FAILED under the same wallet lock.
   */
  async applyInSavepoint(scope: TransactionScope, transaction: WagerTransaction, wallet: Wallet,
    attempts: number, causationId?: string): Promise<AppliedTransaction> {
    const transactionBefore = transaction.toState();
    const walletBefore = wallet.toState();
    try {
      await scope.savepoint(attempt => this.apply(attempt, transaction, wallet, attempts, causationId));
      return { transaction, balance: wallet.balance };
    } catch (error) {
      if (!this.unitOfWork.isPermanentWriteError(error)) throw error;
      const failed = WagerTransaction.rehydrate(transactionBefore);
      failed.fail(FailureCode.PermanentPersistenceError);
      const restored = Wallet.rehydrate(walletBefore);
      await this.recordState(scope, failed, restored, attempts, causationId, true);
      return { transaction: failed, balance: restored.balance };
    }
  }

  private async apply(scope: TransactionScope, transaction: WagerTransaction, wallet: Wallet, attempts: number,
    causationId?: string): Promise<void> {
    const reference = transaction.referenceExternalTransactionId
      ? (await scope.transactions.findByExternalId(transaction.providerId,
        transaction.referenceExternalTransactionId))?.transaction
      : undefined;
    const statusBefore = transaction.status;
    const versionBefore = wallet.version;
    const now = new Date();
    let entry: WalletLedgerEntry | undefined;
    try {
      wallet.assertAccepts(transaction.playerId, transaction.money);
      if (reference) this.assertReferenceUnlessPending(transaction, reference);
      if (transaction.referenceExternalTransactionId && (!reference || !reference.isTerminal())) {
        if (attempts >= maxReferenceAttempts) transaction.reject(FailureCode.ReferenceExpired);
        else transaction.markPendingReference();
      } else {
        transaction.assertReference(reference);
        if (transaction.requiresReference() && await scope.transactions.hasProcessedReversal(reference!.id)) {
          // One reversal per referenced transaction: REFUND and ROLLBACK of the same BET would credit it twice.
          throw new BusinessRuleViolation(FailureCode.AlreadyReversed);
        }
        if (transaction.affectsBalance()) entry = this.move(transaction, wallet, reference, now);
        transaction.markProcessed(reference?.id, now);
      }
    } catch (error) {
      // Only business rules end as REJECTED, and only while the wallet is still untouched.
      if (!(error instanceof BusinessRuleViolation) || wallet.version !== versionBefore) throw error;
      transaction.reject(error.code);
    }
    await this.recordState(scope, transaction, wallet, attempts, causationId, statusBefore !== transaction.status);
    if (entry) {
      await scope.wallets.saveBalance(wallet);
      await scope.ledger.append(entry);
      await this.publish(scope, WalletBalanceChanged.from(wallet, entry,
        { correlationId: entry.transactionId, causationId }));
    }
  }

  /** A reference that is still pending only defers the transaction; any other mismatch rejects it now. */
  private assertReferenceUnlessPending(transaction: WagerTransaction, reference: WagerTransaction): void {
    try {
      transaction.assertReference(reference);
    } catch (error) {
      const pending = error instanceof BusinessRuleViolation && error.code === FailureCode.ReferenceNotProcessed &&
        !reference.isTerminal();
      if (!pending) throw error;
    }
  }

  private move(transaction: WagerTransaction, wallet: Wallet, reference: WagerTransaction | undefined, at: Date) {
    const movement = { entryId: randomUUID(), transactionId: transaction.id, money: transaction.money, at };
    if (transaction.ledgerDirectionFor(reference) === LedgerDirection.Credit) return wallet.credit(movement);
    const insufficientFunds = transaction.kind === WagerTransactionKind.Bet
      ? FailureCode.InsufficientFunds
      : FailureCode.ReversalInsufficientFunds;
    return wallet.debit(movement, insufficientFunds);
  }

  /** Persists the transaction state and, when the state changed, its observed balance and lifecycle event. */
  async recordState(scope: TransactionScope, transaction: WagerTransaction, wallet: Wallet, attempts: number,
    causationId: string | undefined, changed: boolean): Promise<void> {
    const nextAttemptAt = transaction.status === WagerTransactionStatus.PendingReference
      ? new Date(Date.now() + Math.min(maxReferenceDelaySeconds, 2 ** attempts) * 1000)
      : undefined;
    await scope.transactions.saveOutcome(transaction,
      { attempts, nextAttemptAt, observedBalance: changed ? wallet.balance : undefined });
    if (!changed) return;
    const context = { correlationId: transaction.id, causationId };
    switch (transaction.status) {
      case WagerTransactionStatus.Processed:
        return this.publish(scope, WagerTransactionProcessed.from(transaction, wallet.balance, context));
      case WagerTransactionStatus.Rejected:
        return this.publish(scope, WagerTransactionRejected.from(transaction, wallet.balance, context));
      case WagerTransactionStatus.PendingReference:
        return this.publish(scope, WagerTransactionPendingReference.from(transaction, wallet.balance, context));
    }
  }

  /** Events go to the outbox in the same SQL transaction; a worker publishes them after the commit. */
  async publish(scope: TransactionScope, event: IntegrationEvent<unknown>): Promise<void> {
    await scope.outbox.add(OutboxMessage.enqueue(event));
  }
}
