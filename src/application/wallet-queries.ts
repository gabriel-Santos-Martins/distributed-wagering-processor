import { DomainError } from '../domain';
import { outcomeOf } from './outcome';
import type { Telemetry, UnitOfWork } from './ports';

/** Read side: wallet, transactions, ledger pages and reconciliation. */
export class WalletQueries {
  constructor(private readonly unitOfWork: UnitOfWork, private readonly telemetry: Telemetry) {}

  getWallet(walletId: string) {
    return this.unitOfWork.read(async scope => {
      const wallet = await scope.wallets.findById(walletId);
      if (!wallet) throw new DomainError('WALLET_NOT_FOUND', 404);
      return wallet.toJSON();
    });
  }

  /** By internal id, or by provider identity when `providerId` is given. */
  getTransaction(id: string, providerId?: string) {
    return this.unitOfWork.read(async scope => {
      const stored = providerId === undefined
        ? await scope.transactions.findById(id)
        : await scope.transactions.findByExternalId(providerId, id);
      if (!stored) throw new DomainError('TRANSACTION_NOT_FOUND', 404);
      const { transaction, observedBalance } = stored;
      return { ...transaction.toInput(), ...outcomeOf(transaction, observedBalance, false),
        referenceTransactionId: transaction.referenceTransactionId, processedAt: transaction.processedAt };
    });
  }

  ledger(walletId: string, afterSequence: string, limit: number) {
    return this.unitOfWork.read(async scope => {
      if (!await scope.wallets.findById(walletId)) throw new DomainError('WALLET_NOT_FOUND', 404);
      return scope.ledger.page(walletId, afterSequence, limit);
    });
  }

  /** Divergences are reported, logged and counted, never corrected. */
  reconcile(walletId: string) {
    return this.unitOfWork.read(async scope => {
      const report = await scope.ledger.reconcile(walletId);
      if (!report) throw new DomainError('WALLET_NOT_FOUND', 404);
      if (!report.consistent) {
        this.telemetry.log('reconciliation_mismatch', { walletId });
        this.telemetry.increment('reconciliation_mismatches_total');
      }
      return report;
    });
  }
}
