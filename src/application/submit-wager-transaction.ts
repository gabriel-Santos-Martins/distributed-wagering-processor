import { randomUUID } from 'node:crypto';
import { DomainError, WagerTransaction, WagerTransactionStatus, type InboxMessage, type WagerInput } from '../domain';
import { wagerHash } from './contracts';
import { outcomeOf, type TransactionOutcome } from './outcome';
import type { Telemetry, TransactionScope, UnitOfWork } from './ports';
import type { TransactionProcessor } from './transaction-processor';

/**
 * Entry point shared by HTTP and SQS. The inbox record (SQS only), the transaction, the balance change,
 * the ledger entry and the outbox events commit in one SQL transaction.
 */
export class SubmitWagerTransaction {
  constructor(private readonly unitOfWork: UnitOfWork, private readonly processor: TransactionProcessor,
    private readonly telemetry: Telemetry) {}

  /**
   * Returns the outcome, or null for an SQS message the inbox already processed.
   * A FAILED outcome is returned even then, so the consumer can still route it to the DLQ.
   */
  async execute(input: WagerInput, idempotencyKey: string, message?: InboxMessage): Promise<TransactionOutcome | null> {
    const started = performance.now();
    const payloadHash = wagerHash(input);
    const transaction = WagerTransaction.create({ ...input, id: randomUUID(), idempotencyKey, payloadHash });
    try {
      const result = await this.unitOfWork.transaction(async scope => {
        const inbox = message ? await scope.inbox.receive(message) : undefined;
        if (message && inbox && !inbox.matchesPayload(message.payloadHash)) {
          throw new DomainError('INBOX_PAYLOAD_CONFLICT', 409);
        }
        if (inbox?.isProcessed()) {
          this.telemetry.increment('inbox_duplicates_total');
          const replay = await this.replay(scope, input, idempotencyKey, payloadHash);
          return replay?.status === WagerTransactionStatus.Failed ? replay : null;
        }
        const outcome = await this.replay(scope, input, idempotencyKey, payloadHash)
          ?? await this.process(scope, transaction, input, idempotencyKey, payloadHash, message?.messageId);
        if (inbox) {
          inbox.markProcessed(new Date());
          await scope.inbox.save(inbox);
        }
        return outcome;
      });
      if (result) this.report(result, input, message?.messageId);
      return result;
    } catch (error) {
      if (this.unitOfWork.isLockConflict(error)) this.telemetry.increment('lock_conflicts_total');
      throw error;
    } finally {
      this.telemetry.increment('processing_latency_ms_sum', performance.now() - started);
      this.telemetry.increment('processing_latency_ms_count');
    }
  }

  private async process(scope: TransactionScope, transaction: WagerTransaction, input: WagerInput,
    idempotencyKey: string, payloadHash: string, causationId?: string): Promise<TransactionOutcome> {
    const wallet = await scope.wallets.findById(input.walletId, { lock: true });
    if (!wallet) throw new DomainError('WALLET_NOT_FOUND', 404);
    if (await scope.transactions.insertIfAbsent(transaction, causationId)) {
      const applied = await this.processor.applyInSavepoint(scope, transaction, wallet, 0, causationId);
      return outcomeOf(applied.transaction, applied.balance, false);
    }
    // Another submission with the same identity committed while this one waited for the wallet lock.
    const replay = await this.replay(scope, input, idempotencyKey, payloadHash);
    if (!replay) throw new Error('Conflicting transaction is missing');
    return replay;
  }

  /**
   * Original result for the same key and payload. The same key with another payload, or the same external id
   * under another key, is a conflict and never a replay.
   */
  private async replay(scope: TransactionScope, input: WagerInput, idempotencyKey: string, payloadHash: string) {
    const stored = await scope.transactions.findByProviderKeys(input.providerId, idempotencyKey,
      input.externalTransactionId);
    const sameKey = stored.find(row => row.transaction.idempotencyKey === idempotencyKey);
    if (sameKey) {
      if (!sameKey.transaction.matchesPayload(payloadHash)) throw new DomainError('IDEMPOTENCY_CONFLICT', 409);
      return outcomeOf(sameKey.transaction, sameKey.observedBalance, true);
    }
    if (stored.length) throw new DomainError('EXTERNAL_ID_CONFLICT', 409);
    return undefined;
  }

  private report(result: TransactionOutcome, input: WagerInput, messageId?: string): void {
    this.telemetry.increment(result.idempotentReplay
      ? 'idempotency_replays_total'
      : `transactions_${result.status.toLowerCase()}_total`);
    this.telemetry.log('transaction_result', { transactionId: result.transactionId, walletId: input.walletId,
      providerId: input.providerId, status: result.status, correlationId: result.transactionId, messageId });
  }
}
