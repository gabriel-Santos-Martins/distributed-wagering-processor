import type { InboxMessage, Money, WagerInput } from '../domain';
import { OpenWallet } from './open-wallet';
import type { Telemetry, UnitOfWork } from './ports';
import { RetryPendingReference } from './retry-pending-reference';
import { SubmitWagerTransaction } from './submit-wager-transaction';
import { TransactionProcessor } from './transaction-processor';
import { WalletQueries } from './wallet-queries';

/** Application facade used by the HTTP controller, the SQS consumer and the workers. */
export class Wagering {
  private readonly openWallet: OpenWallet;
  private readonly submitTransaction: SubmitWagerTransaction;
  private readonly retryReference: RetryPendingReference;
  private readonly queries: WalletQueries;

  constructor(unitOfWork: UnitOfWork, telemetry: Telemetry) {
    const processor = new TransactionProcessor(unitOfWork);
    this.openWallet = new OpenWallet(unitOfWork, processor);
    this.submitTransaction = new SubmitWagerTransaction(unitOfWork, processor, telemetry);
    this.retryReference = new RetryPendingReference(unitOfWork, processor, telemetry);
    this.queries = new WalletQueries(unitOfWork, telemetry);
  }

  open(playerId: string, initialBalance: Money) { return this.openWallet.execute(playerId, initialBalance); }
  submit(input: WagerInput, idempotencyKey: string, message?: InboxMessage) {
    return this.submitTransaction.execute(input, idempotencyKey, message);
  }
  retryOne() { return this.retryReference.execute(); }
  getWallet(walletId: string) { return this.queries.getWallet(walletId); }
  getTransaction(id: string, providerId?: string) { return this.queries.getTransaction(id, providerId); }
  ledger(walletId: string, afterSequence: string, limit: number) {
    return this.queries.ledger(walletId, afterSequence, limit);
  }
  reconcile(walletId: string) { return this.queries.reconcile(walletId); }
}
