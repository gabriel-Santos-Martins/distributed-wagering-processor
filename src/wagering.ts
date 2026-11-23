import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import { query, type Database } from './database';
import { wagerHash } from './contracts';
import { DomainError, idempotencyMatch, Money, Wallet, WalletLedgerEntry, WagerTransaction,
  type Kind, type Status, type WagerInput } from './domain';
import { InboxMessage, OutboxMessage, WagerTransactionPendingReference,
  WagerTransactionProcessed, WagerTransactionRejected, WalletBalanceChanged, type IntegrationEvent } from './events';
import { log, observe, sqlCode } from './observability';

type WalletRow = { id: string; player_id: string; balance: string; currency: string; version: number };
type WagerRow = {
  id: string; provider_id: string; external_id: string; idempotency_key: string; payload_hash: string;
  wallet_id: string; player_id: string; round_id: string; game_id: string; kind: Kind; amount: string;
  currency: string; reference_external_id: string | null; reference_id: string | null;
  status: Status; failure_code: string | null; processed_at: string | null; observed_balance: string;
  attempts: number; causation_id: string | null;
};
const walletColumns = 'id, player_id, currency, version, balance::text as balance';
const wagerColumns = 'wager.*, amount::text as amount, observed_balance::text as observed_balance';
const money = (amount: string, currency: string) => Money.from({ amount, currency });
// SQLSTATE for deterministic value and integrity errors. Connectivity, lock and
// unknown errors must remain retryable, as must any error outside the savepoint.
const permanentWriteCodes = new Set(['22001', '22003', '23502', '23514']);

function walletFrom(row: WalletRow): Wallet {
  return Wallet.rehydrate({ id: row.id, playerId: row.player_id,
    balance: money(row.balance, row.currency), version: row.version });
}

function transactionFrom(row: WagerRow): WagerTransaction {
  return WagerTransaction.rehydrate(row.id, {
    providerId: row.provider_id, externalTransactionId: row.external_id, walletId: row.wallet_id,
    playerId: row.player_id, roundId: row.round_id, gameId: row.game_id, kind: row.kind,
    money: money(row.amount, row.currency), referenceExternalTransactionId: row.reference_external_id ?? undefined,
  }, { status: row.status, referenceTransactionId: row.reference_id ?? undefined,
    failureCode: row.failure_code ?? undefined, processedAt: row.processed_at ? new Date(row.processed_at).toISOString() : undefined });
}

function outcome(transaction: WagerTransaction, balance: Money, idempotentReplay: boolean) {
  return { transactionId: transaction.id, status: transaction.status, balance: balance.toJSON(),
    idempotentReplay, ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}) };
}

async function enqueue(em: EntityManager, event: IntegrationEvent<unknown>): Promise<void> {
  const { payload } = OutboxMessage.enqueue(event);
  await query(em, 'insert into outbox(id, aggregate_id, event_type, payload, occurred_at) values (?, ?, ?, ?::jsonb, ?)',
    [payload.eventId, payload.aggregateId, payload.eventType, JSON.stringify(payload), payload.occurredAt]);
}

async function persistEntry(em: EntityManager, wallet: Wallet, entry: WalletLedgerEntry, causationId?: string) {
  const { id, transactionId, direction, money: amount, balanceBefore, balanceAfter } = entry.state;
  await query(em, `insert into ledger(id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
    values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, wallet.id, transactionId, direction, amount.toJSON().amount, amount.currency,
      balanceBefore.toJSON().amount, balanceAfter.toJSON().amount]);
  await enqueue(em, new WalletBalanceChanged({ aggregateId: wallet.id, correlationId: transactionId, causationId },
    { walletId: wallet.id, transactionId, direction, money: amount.toJSON(), balanceBefore: balanceBefore.toJSON(),
      balanceAfter: balanceAfter.toJSON(), walletVersion: wallet.version }));
}

export class Wagering {
  constructor(readonly db: Database) {}

  private async findWallet(em: EntityManager, id: string, lock = false): Promise<Wallet> {
    const [row] = await query<WalletRow>(em,
      `select ${walletColumns} from wallet where id = ? ${lock ? 'for update' : ''}`, [id]);
    if (!row) throw new DomainError('WALLET_NOT_FOUND', 404);
    return walletFrom(row);
  }

  async open(playerId: string, initialBalance: Money) {
    const wallet = Wallet.open(randomUUID(), playerId, initialBalance);
    await this.db.em.fork().transactional(async em => {
      const [row] = await query<{ id: string }>(em, `insert into wallet(id, player_id, currency, balance, version)
        values (?, ?, ?, ?, 1) on conflict (player_id, currency) do nothing returning id`,
        [wallet.id, playerId, initialBalance.currency, initialBalance.toJSON().amount]);
      if (!row) throw new DomainError('WALLET_EXISTS', 409);
      if (initialBalance.isZero()) return;
      const transaction = WagerTransaction.create(randomUUID(), {
        providerId: 'internal:opening', externalTransactionId: wallet.id, walletId: wallet.id,
        playerId, roundId: 'opening', gameId: 'opening', kind: 'OPENING', money: initialBalance,
      });
      await this.insert(em, transaction, wallet.id, wagerHash(transaction.input));
      transaction.markProcessed();
      await this.finish(em, transaction, wallet, 0);
      await persistEntry(em, wallet, WalletLedgerEntry.create({
        id: randomUUID(), walletId: wallet.id, transactionId: transaction.id, direction: 'CREDIT',
        money: initialBalance, balanceBefore: Money.zero(initialBalance.currency), balanceAfter: initialBalance,
      }));
    });
    return wallet.toJSON();
  }

  private async insert(em: EntityManager, tx: WagerTransaction, key: string, payloadHash: string, causationId?: string) {
    const { providerId, externalTransactionId, walletId, playerId, roundId, gameId, kind, money: amount,
      referenceExternalTransactionId } = tx.input;
    const [inserted] = await query<{ id: string }>(em, `insert into wager
      (id, provider_id, external_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id,
        kind, amount, currency, reference_external_id, causation_id, status)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING') on conflict do nothing returning id`,
      [tx.id, providerId, externalTransactionId, key, payloadHash, walletId, playerId, roundId, gameId, kind,
        amount.toJSON().amount, amount.currency, referenceExternalTransactionId ?? null, causationId ?? null]);
    return Boolean(inserted);
  }

  private async prior(em: EntityManager, input: WagerInput, key: string, payloadHash: string) {
    const rows = await query<WagerRow>(em, `select ${wagerColumns} from wager
      where provider_id = ? and (idempotency_key = ? or external_id = ?)`,
      [input.providerId, key, input.externalTransactionId]);
    const matchingKey = rows.find(row => row.idempotency_key === key);
    if (matchingKey) {
      idempotencyMatch(matchingKey.payload_hash, payloadHash);
      return outcome(transactionFrom(matchingKey), money(matchingKey.observed_balance, matchingKey.currency), true);
    }
    if (rows.length) throw new DomainError('EXTERNAL_ID_CONFLICT', 409);
    return undefined;
  }

  async submit(input: WagerInput, key: string, envelope?: InboxMessage) {
    const started = performance.now();
    const tx = WagerTransaction.create(randomUUID(), input);
    const payloadHash = wagerHash(input);
    try {
      const result = await this.db.em.fork().transactional(async em => {
        if (envelope) {
          await query(em, `insert into inbox(consumer_name, message_id, payload_hash)
            values (?, ?, ?) on conflict do nothing`, [envelope.consumerName, envelope.messageId, envelope.payloadHash]);
          const [entry] = await query<{ payload_hash: string; processed_at: string | null }>(em,
            'select payload_hash, processed_at from inbox where consumer_name = ? and message_id = ? for update',
            [envelope.consumerName, envelope.messageId]);
          if (entry.payload_hash !== envelope.payloadHash) throw new DomainError('INBOX_PAYLOAD_CONFLICT', 409);
          if (entry.processed_at) {
            observe('inbox_duplicates_total');
            const prior = await this.prior(em, input, key, payloadHash);
            return prior?.status === 'FAILED' ? prior : null;
          }
        }
        let response = await this.prior(em, input, key, payloadHash);
        if (!response) {
          const wallet = await this.findWallet(em, input.walletId, true);
          if (wallet.playerId !== input.playerId) throw new DomainError('PLAYER_WALLET_MISMATCH');
          wallet.balance.assertCurrency(input.money);
          if (await this.insert(em, tx, key, payloadHash, envelope?.messageId)) {
            const applied = await this.applyWithSavepoint(em, tx, wallet, 0, envelope?.messageId);
            response = outcome(applied.transaction, applied.balance, false);
          } else {
            response = await this.prior(em, input, key, payloadHash);
            if (!response) throw new Error('Missing conflicting transaction');
          }
        }
        if (envelope) {
          envelope.markProcessed();
          await query(em, 'update inbox set processed_at = ? where consumer_name = ? and message_id = ?',
            [envelope.processedAt, envelope.consumerName, envelope.messageId]);
        }
        return response;
      });
      if (result) {
        observe(result.idempotentReplay ? 'idempotency_replays_total' : 'transactions_' + result.status.toLowerCase() + '_total');
        log('transaction_result', { transactionId: result.transactionId, walletId: input.walletId,
          providerId: input.providerId, status: result.status, correlationId: result.transactionId, messageId: envelope?.messageId });
      }
      return result;
    } catch (error) {
      if (['55P03', '40P01', '40001'].includes(sqlCode(error) ?? '')) observe('lock_conflicts_total');
      throw error;
    } finally {
      observe('processing_latency_ms_sum', performance.now() - started);
      observe('processing_latency_ms_count');
    }
  }

  private async applyWithSavepoint(em: EntityManager, tx: WagerTransaction, wallet: Wallet, attempts: number,
    causationId?: string) {
    const originalStatus = tx.status;
    const originalWallet = { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance, version: wallet.version };
    try {
      await em.transactional(attempt => this.apply(attempt, tx, wallet, attempts, causationId));
      return { transaction: tx, balance: wallet.balance };
    } catch (error) {
      if (!permanentWriteCodes.has(sqlCode(error) ?? '')) throw error;
      // The savepoint rolled back; the outer transaction still owns the wallet lock.
      const failed = WagerTransaction.rehydrate(tx.id, tx.input, { status: originalStatus });
      failed.fail('PERMANENT_PERSISTENCE_ERROR');
      await this.finish(em, failed, Wallet.rehydrate(originalWallet), attempts, causationId);
      return { transaction: failed, balance: originalWallet.balance };
    }
  }

  private async apply(em: EntityManager, tx: WagerTransaction, wallet: Wallet, attempts: number, causationId?: string) {
    const { referenceExternalTransactionId, providerId, money: amount, kind } = tx.input;
    const [row] = referenceExternalTransactionId ? await query<WagerRow>(em,
      `select ${wagerColumns} from wager where provider_id = ? and external_id = ?`,
      [providerId, referenceExternalTransactionId]) : [];
    const previousStatus = tx.status;
    const previousVersion = wallet.version;
    const reference = row && transactionFrom(row);
    let entry: WalletLedgerEntry | undefined;
    try {
      if (reference) {
        try { tx.direction(reference); } catch (error) {
          if (!(error instanceof DomainError) || error.code !== 'REFERENCE_NOT_PROCESSED' || reference.isTerminal) throw error;
        }
      }
      if (referenceExternalTransactionId && (!reference || !reference.isTerminal)) {
        if (attempts >= 10) tx.reject('REFERENCE_EXPIRED');
        else tx.markPendingReference();
      } else {
        const direction = tx.direction(reference);
        if (tx.isReversal) {
          // One reversal per referenced transaction: REFUND and ROLLBACK of the same BET would credit it twice.
          const [prior] = await query<{ id: string }>(em,
            "select id from wager where reference_id = ? and kind in ('REFUND','ROLLBACK') and status = 'PROCESSED'",
            [reference.id]);
          if (prior) throw new DomainError('ALREADY_REVERSED');
        }
        if (direction && !amount.isZero()) {
          const balanceBefore = wallet.move(direction, amount, kind === 'BET' ? 'INSUFFICIENT_FUNDS' : 'REVERSAL_INSUFFICIENT_FUNDS');
          entry = WalletLedgerEntry.create({ id: randomUUID(), transactionId: tx.id, walletId: wallet.id,
            direction, money: amount, balanceBefore, balanceAfter: wallet.balance });
        }
        tx.markProcessed(reference?.id);
      }
    } catch (error) {
      if (!(error instanceof DomainError) || wallet.version !== previousVersion) throw error;
      tx.reject(error.code);
    }
    await this.finish(em, tx, wallet, attempts, causationId, previousStatus !== tx.status);
    if (entry) {
      await query(em, 'update wallet set balance = ?, version = ?, updated_at = now() where id = ?',
        [wallet.balance.toJSON().amount, wallet.version, wallet.id]);
      await persistEntry(em, wallet, entry, causationId);
    }
  }

  private async finish(em: EntityManager, tx: WagerTransaction, wallet: Wallet, attempts: number,
    causationId?: string, emit = true) {
    const scheduled = tx.status === 'PENDING_REFERENCE'
      ? new Date(Date.now() + Math.min(60, 2 ** attempts) * 1000).toISOString() : null;
    await query(em, `update wager set status = ?, failure_code = ?, reference_id = ?, processed_at = ?,
      observed_balance = case when ? then ?::money_amount else observed_balance end,
      attempts = ?, next_attempt_at = ? where id = ?`,
      [tx.status, tx.failureCode ?? null, tx.referenceTransactionId ?? null, tx.processedAt ?? null,
        emit, wallet.balance.toJSON().amount, attempts, scheduled, tx.id]);
    if (!emit) return;
    const context = { aggregateId: tx.id, correlationId: tx.id, causationId };
    const data = { transactionId: tx.id, walletId: wallet.id, providerId: tx.input.providerId,
      status: tx.status, money: tx.input.money.toJSON(), balance: wallet.balance.toJSON(), failureCode: tx.failureCode };
    switch (tx.status) {
      case 'PROCESSED': await enqueue(em, new WagerTransactionProcessed(context, data)); break;
      case 'REJECTED': await enqueue(em, new WagerTransactionRejected(context, data)); break;
      case 'PENDING_REFERENCE': await enqueue(em, new WagerTransactionPendingReference(context, data)); break;
    }
  }

  async retryOne(): Promise<boolean> {
    const em = this.db.em.fork();
    let candidate: { id: string; next_attempt_at: string } | undefined;
    let result: WagerTransaction | undefined;
    try {
      result = await em.transactional(async context => {
        const [row] = await query<WalletRow & { transaction_id: string }>(context, `
          select w.id, w.player_id, w.currency, w.version, w.balance::text as balance,
            t.id as transaction_id
          from wager t join wallet w on w.id = t.wallet_id
          where t.status = 'PENDING_REFERENCE' and t.next_attempt_at <= now()
          order by t.next_attempt_at, t.id limit 1 for update of w skip locked`);
        if (!row) return undefined;
        const [due] = await query<WagerRow & { next_attempt_at: string }>(context, `select ${wagerColumns}
          from wager where id = ? and status = 'PENDING_REFERENCE' and next_attempt_at <= now() for update`, [row.transaction_id]);
        if (!due) return undefined;
        candidate = { id: due.id, next_attempt_at: due.next_attempt_at };
        const tx = transactionFrom(due);
        const applied = await this.applyWithSavepoint(context, tx, walletFrom(row), due.attempts + 1,
          due.causation_id ?? undefined);
        return applied.transaction;
      });
    } catch (error) {
      if (!candidate) throw error;
      // The financial transaction rolled back. Reorder only this unchanged candidate.
      await query(em, `update wager set next_attempt_at = now() + interval '5 seconds'
        where id = ? and status = 'PENDING_REFERENCE' and next_attempt_at = ?::timestamptz`,
        [candidate.id, candidate.next_attempt_at]);
      observe('reference_retry_failures_total');
      log('reference_retry_deferred', { transactionId: candidate.id, errorCode: sqlCode(error) });
      return true;
    }
    if (!result) return false;
    observe('reference_retries_total');
    if (result.isTerminal) observe('transactions_' + result.status.toLowerCase() + '_total');
    log('reference_retry', { correlationId: result.id, transactionId: result.id,
      walletId: result.input.walletId, providerId: result.input.providerId, status: result.status,
      failureCode: result.failureCode });
    return true;
  }

  async getWallet(walletId: string) { return (await this.findWallet(this.db.em.fork(), walletId)).toJSON(); }

  async getTransaction(id: string, providerId?: string) {
    const [row] = await query<WagerRow>(this.db.em.fork(), `select ${wagerColumns} from wager where
      ${providerId === undefined ? 'id = ?' : 'external_id = ? and provider_id = ?'}`,
    providerId === undefined ? [id] : [id, providerId]);
    if (!row) throw new DomainError('TRANSACTION_NOT_FOUND', 404);
    const transaction = transactionFrom(row);
    return { ...transaction.input, ...outcome(transaction, money(row.observed_balance, row.currency), false),
      referenceTransactionId: transaction.referenceTransactionId, processedAt: transaction.processedAt };
  }

  async ledger(walletId: string, after: string, limit: number) {
    const em = this.db.em.fork();
    await this.findWallet(em, walletId);
    const rows = await query<{ id: string; transaction_id: string; direction: string; amount: string;
      balance_before: string; balance_after: string; currency: string; sequence: string; created_at: string }>(em,
      `select id, transaction_id, direction, amount::text, balance_before::text,
        balance_after::text, currency, sequence::text, created_at from ledger
        where wallet_id = ? and sequence > ?::bigint order by ledger.sequence limit ?`, [walletId, after, limit + 1]);
    const page = rows.slice(0, limit);
    return { entries: page.map(row => ({ id: row.id, walletId, transactionId: row.transaction_id,
      direction: row.direction, money: money(row.amount, row.currency).toJSON(),
      balanceBefore: money(row.balance_before, row.currency).toJSON(), balanceAfter: money(row.balance_after, row.currency).toJSON(),
      createdAt: new Date(row.created_at).toISOString() })), nextSequence: rows.length > limit ? page.at(-1)?.sequence : undefined };
  }

  async reconcile(walletId: string) {
    const [row] = await query<{ stored: string; calculated: string; difference: string; currency: string; count: number; consistent: boolean }>(
      this.db.em.fork(), `select w.balance::numeric(18,2)::text as stored, x.balance::text as calculated,
        (w.balance - x.balance)::text as difference, w.currency, x.count, w.balance = x.balance as consistent
        from wallet w cross join lateral
          (select coalesce(sum(case direction when 'CREDIT' then amount else -amount end), 0) + 0.00 as balance,
            count(*)::int as count from ledger where wallet_id = w.id) x where w.id = ?`, [walletId]);
    if (!row) throw new DomainError('WALLET_NOT_FOUND', 404);
    if (!row.consistent) {
      log('reconciliation_mismatch', { walletId });
      observe('reconciliation_mismatches_total');
    }
    return { walletId, storedBalance: { amount: row.stored, currency: row.currency },
      calculatedBalance: { amount: row.calculated, currency: row.currency },
      difference: { amount: row.difference, currency: row.currency },
      consistent: row.consistent, checkedEntries: row.count };
  }
}
