import type { EntityManager } from '@mikro-orm/postgresql';
import type { TransactionScope, UnitOfWork } from '../../application/ports';
import { sqlCode } from '../observability';
import type { Database } from './database';
import { SqlInboxRepository, SqlLedgerRepository, SqlOutboxRepository, SqlWagerTransactionRepository,
  SqlWalletRepository } from './sql-repositories';

// SQLSTATE for deterministic value and integrity errors. Connectivity, lock and unknown errors stay
// retryable, as does any error raised outside the savepoint.
const permanentWriteCodes = new Set(['22001', '22003', '23502', '23514']);
const lockConflictCodes = new Set(['55P03', '40P01', '40001']);

function scopeFor(em: EntityManager): TransactionScope {
  return {
    wallets: new SqlWalletRepository(em),
    transactions: new SqlWagerTransactionRepository(em),
    ledger: new SqlLedgerRepository(em),
    inbox: new SqlInboxRepository(em),
    outbox: new SqlOutboxRepository(em),
    // A nested EntityManager.transactional() becomes a SAVEPOINT inside the current transaction.
    savepoint: work => em.transactional(nested => work(scopeFor(nested))),
  };
}

/** Each unit of work forks the EntityManager and runs inside EntityManager.transactional(). */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(private readonly db: Database) {}

  transaction<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T> {
    return this.db.em.fork().transactional(em => work(scopeFor(em)));
  }

  read<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T> {
    return work(scopeFor(this.db.em.fork()));
  }

  isPermanentWriteError(error: unknown): boolean {
    return permanentWriteCodes.has(sqlCode(error) ?? '');
  }

  isLockConflict(error: unknown): boolean {
    return lockConflictCodes.has(sqlCode(error) ?? '');
  }
}
