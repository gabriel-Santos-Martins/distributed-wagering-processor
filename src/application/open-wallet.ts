import { randomUUID } from 'node:crypto';
import { DomainError, Wallet, WalletBalanceChanged, WagerTransaction, WagerTransactionKind, type Money,
  type WagerInput } from '../domain';
import { wagerHash } from './contracts';
import type { UnitOfWork } from './ports';
import type { TransactionProcessor } from './transaction-processor';

/** Reserved provider of the internal OPENING transaction; external input cannot use it. */
export const openingProviderId = 'internal:opening';

/** Opens a wallet. A positive opening balance becomes an OPENING transaction and its CREDIT in the same SQL transaction. */
export class OpenWallet {
  constructor(private readonly unitOfWork: UnitOfWork, private readonly processor: TransactionProcessor) {}

  async execute(playerId: string, initialBalance: Money) {
    const now = new Date();
    const wallet = Wallet.open({ id: randomUUID(), playerId, initialBalance, at: now });
    await this.unitOfWork.transaction(async scope => {
      if (!await scope.wallets.insertIfAbsent(wallet)) throw new DomainError('WALLET_EXISTS', 409);
      if (initialBalance.isZero()) return;
      const input: WagerInput = { providerId: openingProviderId, externalTransactionId: wallet.id,
        walletId: wallet.id, playerId, roundId: 'opening', gameId: 'opening', kind: WagerTransactionKind.Opening,
        money: initialBalance };
      const opening = WagerTransaction.create({ ...input, id: randomUUID(), idempotencyKey: wallet.id,
        payloadHash: wagerHash(input), createdAt: now });
      await scope.transactions.insertIfAbsent(opening);
      const entry = wallet.openingEntry({ entryId: randomUUID(), transactionId: opening.id });
      opening.markProcessed(undefined, now);
      // The ledger trigger accepts the entry only for a PROCESSED transaction with the matching observed balance.
      await this.processor.recordState(scope, opening, wallet, 0, undefined, true);
      if (entry) {
        await scope.ledger.append(entry);
        await this.processor.publish(scope, WalletBalanceChanged.from(wallet, entry, { correlationId: opening.id }));
      }
    });
    return wallet.toJSON();
  }
}
