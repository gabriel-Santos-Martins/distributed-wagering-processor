import type { EntityManager } from '@mikro-orm/postgresql';
import type { InboxRepository, LedgerEntryView, LedgerRepository, OutboxRepository, ReconciliationView,
  StoredWagerTransaction, TransactionOutcomeUpdate, WagerTransactionRepository,
  WalletRepository } from '../../application/ports';
import { InboxMessage, Money, OutboxMessage, Wallet, WagerTransaction, type FailureCode, type WalletLedgerEntry,
  type WagerTransactionKind, type WagerTransactionStatus } from '../../domain';
import { query } from './database';

// Explicit SQL keeps lock order, SKIP LOCKED, numeric casts and partial-index conditions visible.
// Money is written as its decimal string and read back with ::text, so no value passes through a float.

type Timestamp = string | Date;
const date = (value: Timestamp) => new Date(value);
const money = (amount: string, currency: string) => Money.from({ amount, currency });
const iso = (value: Date | undefined) => value?.toISOString() ?? null;

type WalletRow = {
  id: string; player_id: string; currency: string; version: number; balance: string;
  created_at: Timestamp; updated_at: Timestamp;
};
const walletColumns = (alias: string) => `${alias}.id, ${alias}.player_id, ${alias}.currency, ${alias}.version,
  ${alias}.balance::text as balance, ${alias}.created_at, ${alias}.updated_at`;

function walletFrom(row: WalletRow): Wallet {
  return Wallet.rehydrate({ id: row.id, playerId: row.player_id, currency: row.currency,
    balance: money(row.balance, row.currency), version: row.version,
    createdAt: date(row.created_at), updatedAt: date(row.updated_at) });
}

type WagerRow = {
  id: string; provider_id: string; external_id: string; idempotency_key: string; payload_hash: string;
  wallet_id: string; player_id: string; round_id: string; game_id: string; kind: WagerTransactionKind;
  amount: string; currency: string; reference_external_id: string | null; reference_id: string | null;
  status: WagerTransactionStatus; failure_code: string | null; processed_at: Timestamp | null;
  observed_balance: string | null; wallet_currency: string; attempts: number; next_attempt_at: Timestamp | null;
  causation_id: string | null; created_at: Timestamp;
};
// The observed balance belongs to the wallet, so it is read in the wallet's currency.
const wagerSelect = `select t.*, t.amount::text as amount, t.observed_balance::text as observed_balance,
  w.currency as wallet_currency from wager t join wallet w on w.id = t.wallet_id`;

function storedFrom(row: WagerRow): StoredWagerTransaction {
  const transaction = WagerTransaction.rehydrate({
    id: row.id, providerId: row.provider_id, externalTransactionId: row.external_id,
    idempotencyKey: row.idempotency_key, payloadHash: row.payload_hash, walletId: row.wallet_id,
    playerId: row.player_id, roundId: row.round_id, gameId: row.game_id, kind: row.kind,
    money: money(row.amount, row.currency), referenceExternalTransactionId: row.reference_external_id ?? undefined,
    createdAt: date(row.created_at), status: row.status, referenceTransactionId: row.reference_id ?? undefined,
    // Persisted codes were written from FailureCode by this service.
    failureCode: (row.failure_code ?? undefined) as FailureCode | undefined,
    processedAt: row.processed_at ? date(row.processed_at) : undefined,
  });
  return {
    transaction,
    observedBalance: money(row.observed_balance ?? '0.00', row.wallet_currency),
    attempts: row.attempts,
    causationId: row.causation_id ?? undefined,
    nextAttemptAt: row.next_attempt_at ? date(row.next_attempt_at) : undefined,
  };
}

export class SqlWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async insertIfAbsent(wallet: Wallet): Promise<boolean> {
    const rows = await query<{ id: string }>(this.em, `insert into wallet(id, player_id, currency, balance, version,
        created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?) on conflict (player_id, currency) do nothing returning id`,
      [wallet.id, wallet.playerId, wallet.currency, wallet.balance.toJSON().amount, wallet.version,
        iso(wallet.createdAt), iso(wallet.updatedAt)]);
    return rows.length > 0;
  }

  async findById(id: string, options: { lock?: boolean } = {}): Promise<Wallet | undefined> {
    const [row] = await query<WalletRow>(this.em,
      `select ${walletColumns('w')} from wallet w where w.id = ? ${options.lock ? 'for update' : ''}`, [id]);
    return row && walletFrom(row);
  }

  async saveBalance(wallet: Wallet): Promise<void> {
    // The row is locked by findById({ lock: true }); the write is not a blind read-calculate-update.
    await query(this.em, 'update wallet set balance = ?, version = ?, updated_at = ? where id = ?',
      [wallet.balance.toJSON().amount, wallet.version, iso(wallet.updatedAt), wallet.id]);
  }
}

export class SqlWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async insertIfAbsent(transaction: WagerTransaction, causationId?: string): Promise<boolean> {
    const rows = await query<{ id: string }>(this.em, `insert into wager
      (id, provider_id, external_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id,
        kind, amount, currency, reference_external_id, causation_id, status, created_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing returning id`,
      [transaction.id, transaction.providerId, transaction.externalTransactionId, transaction.idempotencyKey,
        transaction.payloadHash, transaction.walletId, transaction.playerId, transaction.roundId, transaction.gameId,
        transaction.kind, transaction.money.toJSON().amount, transaction.money.currency,
        transaction.referenceExternalTransactionId ?? null, causationId ?? null, transaction.status,
        iso(transaction.createdAt)]);
    return rows.length > 0;
  }

  async findByProviderKeys(providerId: string, idempotencyKey: string, externalTransactionId: string) {
    const rows = await query<WagerRow>(this.em,
      `${wagerSelect} where t.provider_id = ? and (t.idempotency_key = ? or t.external_id = ?)`,
      [providerId, idempotencyKey, externalTransactionId]);
    return rows.map(storedFrom);
  }

  async findByExternalId(providerId: string, externalTransactionId: string) {
    const [row] = await query<WagerRow>(this.em, `${wagerSelect} where t.provider_id = ? and t.external_id = ?`,
      [providerId, externalTransactionId]);
    return row && storedFrom(row);
  }

  async findById(id: string) {
    const [row] = await query<WagerRow>(this.em, `${wagerSelect} where t.id = ?`, [id]);
    return row && storedFrom(row);
  }

  async saveOutcome(transaction: WagerTransaction, update: TransactionOutcomeUpdate): Promise<void> {
    await query(this.em, `update wager set status = ?, failure_code = ?, reference_id = ?, processed_at = ?,
        observed_balance = coalesce(?::money_amount, observed_balance), attempts = ?, next_attempt_at = ?
      where id = ?`,
      [transaction.status, transaction.failureCode ?? null, transaction.referenceTransactionId ?? null,
        iso(transaction.processedAt), update.observedBalance?.toJSON().amount ?? null, update.attempts,
        iso(update.nextAttemptAt), transaction.id]);
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const rows = await query(this.em, `select 1 from wager
      where reference_id = ? and kind in ('REFUND', 'ROLLBACK') and status = 'PROCESSED'`, [referenceTransactionId]);
    return rows.length > 0;
  }

  async claimDuePendingReference() {
    const [walletRow] = await query<WalletRow & { transaction_id: string }>(this.em, `
      select ${walletColumns('w')}, t.id as transaction_id
      from wager t join wallet w on w.id = t.wallet_id
      where t.status = 'PENDING_REFERENCE' and t.next_attempt_at <= now()
      order by t.next_attempt_at, t.id limit 1 for update of w skip locked`);
    if (!walletRow) return undefined;
    // Re-read status and due time under the wallet lock: another worker may have finished it meanwhile.
    const [row] = await query<WagerRow>(this.em, `${wagerSelect}
      where t.id = ? and t.status = 'PENDING_REFERENCE' and t.next_attempt_at <= now() for update of t`,
      [walletRow.transaction_id]);
    return row && { wallet: walletFrom(walletRow), pending: storedFrom(row) };
  }

  async deferPendingReference(id: string, expectedNextAttemptAt: Date, delaySeconds: number): Promise<void> {
    // A JavaScript Date has millisecond precision; timestamptz keeps microseconds.
    await query(this.em, `update wager set next_attempt_at = now() + ?::int * interval '1 second'
      where id = ? and status = 'PENDING_REFERENCE'
        and date_trunc('milliseconds', next_attempt_at) = date_trunc('milliseconds', ?::timestamptz)`,
      [delaySeconds, id, iso(expectedNextAttemptAt)]);
  }
}

export class SqlLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await query(this.em, `insert into ledger(id, wallet_id, transaction_id, direction, amount, currency,
        balance_before, balance_after, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [entry.id, entry.walletId, entry.transactionId, entry.direction, entry.money.toJSON().amount,
        entry.money.currency, entry.balanceBefore.toJSON().amount, entry.balanceAfter.toJSON().amount,
        iso(entry.createdAt)]);
  }

  async page(walletId: string, afterSequence: string, limit: number) {
    const rows = await query<{ id: string; transaction_id: string; direction: string; amount: string;
      balance_before: string; balance_after: string; currency: string; sequence: string; created_at: Timestamp }>(
      this.em, `select id, transaction_id, direction, amount::text, balance_before::text, balance_after::text,
        currency, sequence::text, created_at from ledger
      where wallet_id = ? and sequence > ?::bigint order by sequence limit ?`, [walletId, afterSequence, limit + 1]);
    const page = rows.slice(0, limit);
    const entries: LedgerEntryView[] = page.map(row => ({
      id: row.id, walletId, transactionId: row.transaction_id, direction: row.direction,
      money: money(row.amount, row.currency).toJSON(),
      balanceBefore: money(row.balance_before, row.currency).toJSON(),
      balanceAfter: money(row.balance_after, row.currency).toJSON(),
      createdAt: date(row.created_at).toISOString(),
    }));
    return { entries, nextSequence: rows.length > limit ? page.at(-1)?.sequence : undefined };
  }

  async reconcile(walletId: string): Promise<ReconciliationView | undefined> {
    // One statement, so both sides come from the same MVCC snapshot.
    const [row] = await query<{ stored: string; calculated: string; difference: string; currency: string;
      count: number; consistent: boolean }>(this.em, `
      select w.balance::numeric(18,2)::text as stored, x.balance::text as calculated,
        (w.balance - x.balance)::text as difference, w.currency, x.count, w.balance = x.balance as consistent
      from wallet w cross join lateral (
        select coalesce(sum(case direction when 'CREDIT' then amount else -amount end), 0) + 0.00 as balance,
          count(*)::int as count
        from ledger where wallet_id = w.id) x
      where w.id = ?`, [walletId]);
    if (!row) return undefined;
    const amount = (value: string) => ({ amount: value, currency: row.currency });
    return { walletId, storedBalance: amount(row.stored), calculatedBalance: amount(row.calculated),
      difference: amount(row.difference), consistent: row.consistent, checkedEntries: row.count };
  }
}

export class SqlInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async receive(message: InboxMessage): Promise<InboxMessage> {
    await query(this.em, `insert into inbox(consumer_name, message_id, payload_hash, received_at)
      values (?, ?, ?, ?) on conflict do nothing`,
      [message.consumerName, message.messageId, message.payloadHash, iso(message.receivedAt)]);
    const [row] = await query<{ payload_hash: string; received_at: Timestamp; processed_at: Timestamp | null }>(
      this.em, `select payload_hash, received_at, processed_at from inbox
        where consumer_name = ? and message_id = ? for update`, [message.consumerName, message.messageId]);
    return InboxMessage.rehydrate({ messageId: message.messageId, consumerName: message.consumerName,
      payloadHash: row.payload_hash, receivedAt: date(row.received_at),
      processedAt: row.processed_at ? date(row.processed_at) : undefined });
  }

  async save(message: InboxMessage): Promise<void> {
    await query(this.em, 'update inbox set processed_at = ? where consumer_name = ? and message_id = ?',
      [iso(message.processedAt), message.consumerName, message.messageId]);
  }
}

export class SqlOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async add(message: OutboxMessage): Promise<void> {
    await query(this.em, `insert into outbox(id, aggregate_id, event_type, payload, occurred_at, next_attempt_at,
        attempts) values (?, ?, ?, ?::jsonb, ?, ?, ?)`,
      [message.id, message.aggregateId, message.eventType, JSON.stringify(message.payload), iso(message.occurredAt),
        iso(message.nextAttemptAt ?? message.occurredAt), message.attempts]);
  }

  async claimNextDue() {
    const [row] = await query<{ id: string; aggregate_id: string; event_type: string;
      payload: Record<string, unknown>; occurred_at: Timestamp; attempts: number; next_attempt_at: Timestamp;
      lag: number }>(this.em, `
      select id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at,
        extract(epoch from (now() - occurred_at))::float8 as lag
      from outbox where published_at is null and next_attempt_at <= now()
      order by next_attempt_at, id limit 1 for update skip locked`);
    if (!row) return undefined;
    const message = OutboxMessage.rehydrate({ id: row.id, aggregateId: row.aggregate_id, eventType: row.event_type,
      payload: row.payload, occurredAt: date(row.occurred_at), attempts: row.attempts,
      nextAttemptAt: date(row.next_attempt_at) });
    return { message, lagSeconds: row.lag };
  }

  async save(message: OutboxMessage): Promise<void> {
    await query(this.em, 'update outbox set attempts = ?, next_attempt_at = ?, published_at = ? where id = ?',
      [message.attempts, iso(message.nextAttemptAt), iso(message.publishedAt), message.id]);
  }
}
