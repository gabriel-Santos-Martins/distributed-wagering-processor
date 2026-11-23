import type { Telemetry, UnitOfWork } from './ports';
import type { TransactionProcessor } from './transaction-processor';

/** Delay applied to a candidate whose attempt aborted, so other due work goes first. */
const abortedAttemptDelaySeconds = 5;

/** Worker step: reprocesses one due PENDING_REFERENCE transaction. Returns false when nothing was due. */
export class RetryPendingReference {
  constructor(private readonly unitOfWork: UnitOfWork, private readonly processor: TransactionProcessor,
    private readonly telemetry: Telemetry) {}

  async execute(): Promise<boolean> {
    let candidate: { id: string; nextAttemptAt: Date } | undefined;
    let applied;
    try {
      applied = await this.unitOfWork.transaction(async scope => {
        const claimed = await scope.transactions.claimDuePendingReference();
        if (!claimed) return undefined;
        const { wallet, pending } = claimed;
        candidate = { id: pending.transaction.id, nextAttemptAt: pending.nextAttemptAt! };
        return this.processor.applyInSavepoint(scope, pending.transaction, wallet, pending.attempts + 1,
          pending.causationId);
      });
    } catch (error) {
      if (!candidate) throw error;
      // The financial transaction rolled back. Reorder only this unchanged candidate.
      await this.unitOfWork.read(scope => scope.transactions.deferPendingReference(candidate!.id,
        candidate!.nextAttemptAt, abortedAttemptDelaySeconds));
      this.telemetry.increment('reference_retry_failures_total');
      this.telemetry.log('reference_retry_deferred', { transactionId: candidate.id,
        errorType: error instanceof Error ? error.name : 'UnknownError' });
      return true;
    }
    if (!applied) return false;
    const { transaction } = applied;
    this.telemetry.increment('reference_retries_total');
    if (transaction.isTerminal()) this.telemetry.increment(`transactions_${transaction.status.toLowerCase()}_total`);
    this.telemetry.log('reference_retry', { correlationId: transaction.id, transactionId: transaction.id,
      walletId: transaction.walletId, providerId: transaction.providerId, status: transaction.status,
      failureCode: transaction.failureCode });
    return true;
  }
}
