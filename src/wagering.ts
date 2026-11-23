import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import { query, type Database } from './database';
import { wagerHash } from './contracts';
import { BusinessRuleViolation, DomainError, FailureCode, InboxMessage, LedgerDirection, Money, OutboxMessage, Wallet,
  WalletBalanceChanged, WagerTransaction, WagerTransactionKind, WagerTransactionPendingReference,
  WagerTransactionProcessed, WagerTransactionRejected, WagerTransactionStatus, type IntegrationEvent,
  type WagerInput, type WalletLedgerEntry } from './domain';
import { log, observe, sqlCode } from './observability';

type Timestamp = string | Date;
type WalletRow = {
  id: string; player_id: string; balance: string; currency: string; version: number;
  created_at: Timestamp; updated_at: Timestamp;
};
type WagerRow = {
  id: string; provider_id: string; external_id: string; idempotency_key: string; payload_hash: string;
  wallet_id: string; player_id: string; round_id: string; game_id: string; kind: WagerTransactionKind; amount: string;
  currency: string; reference_external_id: string | null; reference_id: string | null;
  status: WagerTransactionStatus; failure_code: string | null; processed_at: Timestamp | null;
  observed_balance: string; attempts: number; causation_id: string | null; created_at: Timestamp;
};
type InboxRow = { payload_hash: string; received_at: Timestamp; processed_at: Timestamp | null };

const walletColumns = 'id, player_id, currency, version, balance::text as balance, created_at, updated_at';
const wagerColumns = 'wager.*, amount::text as amount, observed_balance::text as observed_balance';
const money = (amount: string, currency: string) => Money.from({ amount, currency });
/** Scheduled attempts for a missing reference before REFERENCE_EXPIRED (backoff 1, 2, 4 ... 60 s). */
const maxReferenceAttempts = 10;
// SQLSTATE for deterministic value and integrity errors. Connectivity, lock and
// unknown errors must remain retryable, as must any error outside the savepoint.
const permanentWriteCodes = new Set(['22001', '22003', '23502', '23514']);

function walletFrom(row: WalletRow): Wallet {
  return Wallet.rehydrate({ id: row.id, playerId: row.player_id, currency: row.currency,
    balance: money(row.balance, row.currency), version: row.version,
    createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at) });
}

function transactionFrom(row: WagerRow): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: row.id, providerId: row.provider_id, externalTransactionId: row.external_id,
    idempotencyKey: row.idempotency_key, payloadHash: row.payload_hash, walletId: row.wallet_id,
    playerId: row.player_id, roundId: row.round_id, gameId: row.game_id, kind: row.kind,
    money: money(row.amount, row.currency), referenceExternalTransactionId: row.reference_external_id ?? undefined,
    createdAt: new Date(row.created_at), status: row.status, referenceTransactionId: row.reference_id ?? undefined,
    // Persisted codes were written from FailureCode by this service.
    failureCode: (row.failure_code ?? undefined) as FailureCode | undefined,
    processedAt: row.processed_at ? new Date(row.processed_at) : undefined,
  });
}

function outcome(transaction: WagerTransaction, balance: Money, idempotentReplay: boolean) {
  return { transactionId: transaction.id, status: transaction.status, balance: balance.toJSON(),
    idempotentReplay, ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}) };
}

async function enqueue(em: EntityManager, event: IntegrationEvent<unknown>): Promise<void> {
  const message = OutboxMessage.enqueue(event);
  await query(em, `insert into outbox(id, aggregate_id, event_type, payload, occurred_at, next_attempt_at, attempts)
    values (?, ?, ?, ?::jsonb, ?, ?, ?)`,
    [message.id, message.aggregateId, message.eventType, JSON.stringify(message.payload),
      message.occurredAt.toISOString(), (message.nextAttemptAt ?? message.occurredAt).toISOString(), message.attempts]);
}

async function persistEntry(em: EntityManager, wallet: Wallet, entry: WalletLedgerEntry, causationId?: string) {
  await query(em, `insert into ledger(id, wallet_id, transaction_id, direction, amount, currency, balance_before,
      balance_after, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [entry.id, entry.walletId, entry.transactionId, entry.direction, entry.money.toJSON().amount,
      entry.money.currency, entry.balanceBefore.toJSON().amount, entry.balanceAfter.toJSON().amount,
      entry.createdAt.toISOString()]);
  await enqueue(em, WalletBalanceChanged.from(wallet, entry, { correlationId: entry.transactionId, causationId }));
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
    const now = new Date();
    const wallet = Wallet.open({ id: randomUUID(), playerId, initialBalance, at: now });
    await this.db.em.fork().transactional(async em => {
      const [row] = await query<{ id: string }>(em, `insert into wallet(id, player_id, currency, balance, version,
          created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?) on conflict (player_id, currency) do nothing returning id`,
        [wallet.id, playerId, wallet.currency, wallet.balance.toJSON().amount, wallet.version,
          wallet.createdAt.toISOString(), wallet.updatedAt.toISOString()]);
      if (!row) throw new DomainError('WALLET_EXISTS', 409);
      if (initialBalance.isZero()) return;
      const input: WagerInput = { providerId: 'internal:opening', externalTransactionId: wallet.id,
        walletId: wallet.id, playerId, roundId: 'opening', gameId: 'opening', kind: WagerTransactionKind.Opening,
        money: initialBalance };
      const transaction = WagerTransaction.create({ ...input, id: randomUUID(), idempotencyKey: wallet.id,
        payloadHash: wagerHash(input), createdAt: now });
      await this.insert(em, transaction);
      const entry = wallet.openingEntry({ entryId: randomUUID(), transactionId: transaction.id });
      transaction.markProcessed(undefined, now);
      // The ledger trigger requires a PROCESSED wager whose observed balance matches the entry.
      await this.finish(em, transaction, wallet, 0);
      if (entry) await persistEntry(em, wallet, entry);
    });
    return wallet.toJSON();
  }

  private async insert(em: EntityManager, tx: WagerTransaction, causationId?: string) {
    const [inserted] = await query<{ id: string }>(em, `insert into wager
      (id, provider_id, external_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id,
        kind, amount, currency, reference_external_id, causation_id, status, created_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing returning id`,
      [tx.id, tx.providerId, tx.externalTransactionId, tx.idempotencyKey, tx.payloadHash, tx.walletId, tx.playerId,
        tx.roundId, tx.gameId, tx.kind, tx.money.toJSON().amount, tx.money.currency,
        tx.referenceExternalTransactionId ?? null, causationId ?? null, tx.status, tx.createdAt.toISOString()]);
    return Boolean(inserted);
  }

  /** Replay of the original result for the same key and payload; conflict for a different payload or key. */
  private async prior(em: EntityManager, input: WagerInput, key: string, payloadHash: string) {
    const rows = await query<WagerRow>(em, `select ${wagerColumns} from wager
      where provider_id = ? and (idempotency_key = ? or external_id = ?)`,
      [input.providerId, key, input.externalTransactionId]);
    const matchingKey = rows.find(row => row.idempotency_key === key);
    if (matchingKey) {
      const original = transactionFrom(matchingKey);
      if (!original.matchesPayload(payloadHash)) throw new DomainError('IDEMPOTENCY_CONFLICT', 409);
      return outcome(original, money(matchingKey.observed_balance, matchingKey.currency), true);
    }
    if (rows.length) throw new DomainError('EXTERNAL_ID_CONFLICT', 409);
    return undefined;
  }

  async submit(input: WagerInput, key: string, envelope?: InboxMessage) {
    const started = performance.now();
    const payloadHash = wagerHash(input);
    const tx = WagerTransaction.create({ ...input, id: randomUUID(), idempotencyKey: key, payloadHash });
    try {
      const result = await this.db.em.fork().transactional(async em => {
        let inbox: InboxMessage | undefined;
        if (envelope) {
          await query(em, `insert into inbox(consumer_name, message_id, payload_hash, received_at)
            values (?, ?, ?, ?) on conflict do nothing`,
            [envelope.consumerName, envelope.messageId, envelope.payloadHash, envelope.receivedAt.toISOString()]);
          const [row] = await query<InboxRow>(em, `select payload_hash, received_at, processed_at from inbox
            where consumer_name = ? and message_id = ? for update`, [envelope.consumerName, envelope.messageId]);
          inbox = InboxMessage.rehydrate({ messageId: envelope.messageId, consumerName: envelope.consumerName,
            payloadHash: row.payload_hash, receivedAt: new Date(row.received_at),
            processedAt: row.processed_at ? new Date(row.processed_at) : undefined });
          if (!inbox.matchesPayload(envelope.payloadHash)) throw new DomainError('INBOX_PAYLOAD_CONFLICT', 409);
          if (inbox.isProcessed()) {
            observe('inbox_duplicates_total');
            const prior = await this.prior(em, input, key, payloadHash);
            return prior?.status === WagerTransactionStatus.Failed ? prior : null;
          }
        }
        let response = await this.prior(em, input, key, payloadHash);
        if (!response) {
          const wallet = await this.findWallet(em, input.walletId, true);
          wallet.assertAccepts(input.playerId, input.money);
          if (await this.insert(em, tx, envelope?.messageId)) {
            const applied = await this.applyWithSavepoint(em, tx, wallet, 0, envelope?.messageId);
            response = outcome(applied.transaction, applied.balance, false);
          } else {
            response = await this.prior(em, input, key, payloadHash);
            if (!response) throw new Error('Missing conflicting transaction');
          }
        }
        if (inbox) {
          inbox.markProcessed(new Date());
          await query(em, 'update inbox set processed_at = ? where consumer_name = ? and message_id = ?',
            [inbox.processedAt!.toISOString(), inbox.consumerName, inbox.messageId]);
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
    const transactionBefore = tx.toState();
    const walletBefore = wallet.toState();
    try {
      await em.transactional(attempt => this.apply(attempt, tx, wallet, attempts, causationId));
      return { transaction: tx, balance: wallet.balance };
    } catch (error) {
      if (!permanentWriteCodes.has(sqlCode(error) ?? '')) throw error;
      // The savepoint rolled back; the outer transaction still owns the wallet lock.
      const failed = WagerTransaction.rehydrate(transactionBefore);
      failed.fail(FailureCode.PermanentPersistenceError);
      const restored = Wallet.rehydrate(walletBefore);
      await this.finish(em, failed, restored, attempts, causationId);
      return { transaction: failed, balance: restored.balance };
    }
  }

  private async apply(em: EntityManager, tx: WagerTransaction, wallet: Wallet, attempts: number, causationId?: string) {
    const [row] = tx.referenceExternalTransactionId ? await query<WagerRow>(em,
      `select ${wagerColumns} from wager where provider_id = ? and external_id = ?`,
      [tx.providerId, tx.referenceExternalTransactionId]) : [];
    const reference = row ? transactionFrom(row) : undefined;
    const previousStatus = tx.status;
    const previousVersion = wallet.version;
    const now = new Date();
    let entry: WalletLedgerEntry | undefined;
    try {
      if (reference) {
        // A reference that is still pending only defers this transaction; any other mismatch rejects it now.
        try { tx.assertReference(reference); } catch (error) {
          if (!(error instanceof BusinessRuleViolation) || error.code !== FailureCode.ReferenceNotProcessed ||
              reference.isTerminal()) throw error;
        }
      }
      if (tx.referenceExternalTransactionId && (!reference || !reference.isTerminal())) {
        if (attempts >= maxReferenceAttempts) tx.reject(FailureCode.ReferenceExpired);
        else tx.markPendingReference();
      } else {
        tx.assertReference(reference);
        if (tx.requiresReference()) {
          // One reversal per referenced transaction: REFUND and ROLLBACK of the same BET would credit it twice.
          const [prior] = await query<{ id: string }>(em,
            "select id from wager where reference_id = ? and kind in ('REFUND','ROLLBACK') and status = 'PROCESSED'",
            [reference!.id]);
          if (prior) throw new BusinessRuleViolation(FailureCode.AlreadyReversed);
        }
        if (tx.affectsBalance()) {
          const movement = { entryId: randomUUID(), transactionId: tx.id, money: tx.money, at: now };
          entry = tx.ledgerDirectionFor(reference) === LedgerDirection.Debit
            ? wallet.debit(movement, tx.kind === WagerTransactionKind.Bet
              ? FailureCode.InsufficientFunds : FailureCode.ReversalInsufficientFunds)
            : wallet.credit(movement);
        }
        tx.markProcessed(reference?.id, now);
      }
    } catch (error) {
      if (!(error instanceof BusinessRuleViolation) || wallet.version !== previousVersion) throw error;
      tx.reject(error.code);
    }
    await this.finish(em, tx, wallet, attempts, causationId, previousStatus !== tx.status);
    if (entry) {
      await query(em, 'update wallet set balance = ?, version = ?, updated_at = ? where id = ?',
        [wallet.balance.toJSON().amount, wallet.version, wallet.updatedAt.toISOString(), wallet.id]);
      await persistEntry(em, wallet, entry, causationId);
    }
  }

  /** Persists the transaction state and, when the state changed, its lifecycle event. */
  private async finish(em: EntityManager, tx: WagerTransaction, wallet: Wallet, attempts: number,
    causationId?: string, emit = true) {
    const scheduled = tx.status === WagerTransactionStatus.PendingReference
      ? new Date(Date.now() + Math.min(60, 2 ** attempts) * 1000).toISOString() : null;
    await query(em, `update wager set status = ?, failure_code = ?, reference_id = ?, processed_at = ?,
      observed_balance = case when ? then ?::money_amount else observed_balance end,
      attempts = ?, next_attempt_at = ? where id = ?`,
      [tx.status, tx.failureCode ?? null, tx.referenceTransactionId ?? null, tx.processedAt?.toISOString() ?? null,
        emit, wallet.balance.toJSON().amount, attempts, scheduled, tx.id]);
    if (!emit) return;
    const context = { correlationId: tx.id, causationId };
    switch (tx.status) {
      case WagerTransactionStatus.Processed:
        await enqueue(em, WagerTransactionProcessed.from(tx, wallet.balance, context)); break;
      case WagerTransactionStatus.Rejected:
        await enqueue(em, WagerTransactionRejected.from(tx, wallet.balance, context)); break;
      case WagerTransactionStatus.PendingReference:
        await enqueue(em, WagerTransactionPendingReference.from(tx, wallet.balance, context)); break;
    }
  }

  async retryOne(): Promise<boolean> {
    const em = this.db.em.fork();
    let candidate: { id: string; next_attempt_at: Timestamp } | undefined;
    let result: WagerTransaction | undefined;
    try {
      result = await em.transactional(async context => {
        const [row] = await query<WalletRow & { transaction_id: string }>(context, `
          select w.id, w.player_id, w.currency, w.version, w.balance::text as balance,
            w.created_at, w.updated_at, t.id as transaction_id
          from wager t join wallet w on w.id = t.wallet_id
          where t.status = 'PENDING_REFERENCE' and t.next_attempt_at <= now()
          order by t.next_attempt_at, t.id limit 1 for update of w skip locked`);
        if (!row) return undefined;
        const [due] = await query<WagerRow & { next_attempt_at: Timestamp }>(context, `select ${wagerColumns}
          from wager where id = ? and status = 'PENDING_REFERENCE' and next_attempt_at <= now() for update`, [row.transaction_id]);
        if (!due) return undefined;
        candidate = { id: due.id, next_attempt_at: due.next_attempt_at };
        const applied = await this.applyWithSavepoint(context, transactionFrom(due), walletFrom(row), due.attempts + 1,
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
    if (result.isTerminal()) observe('transactions_' + result.status.toLowerCase() + '_total');
    log('reference_retry', { correlationId: result.id, transactionId: result.id,
      walletId: result.walletId, providerId: result.providerId, status: result.status,
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
    return { ...transaction.toInput(), ...outcome(transaction, money(row.observed_balance, row.currency), false),
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
