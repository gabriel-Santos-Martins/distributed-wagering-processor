import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { query } from '../src/database';
import { InboxMessage } from '../src/events';
import { wagerFrom, hash } from '../src/contracts';
import { Money } from '../src/domain';
import { Wagering } from '../src/wagering';
import { checkLedger, dto, ids, setup } from './support';

let connection: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { connection = await setup(false); }, 20000);
afterAll(async () => { await connection?.db.close(true); connection?.queues.client.destroy(); });

test('migration down/up and direct SQL guards for uniqueness, scale, balance, arithmetic and immutability', async () => {
  // Run against a disposable database with every app stopped.
  const { db } = connection;
  const migrator = db.getMigrator();
  await migrator.down({ to: 0 });
  expect(await query(db.em.fork(), "select to_regclass('wallet') as wallet")).toEqual([{ wallet: null }]);
  await migrator.up();
  const api = new Wagering(db);
  const { playerId } = ids();
  const wallet = await api.open(playerId, Money.from(dto('100')));
  const run = (sql: string, args: unknown[] = [wallet.id]) => query(db.em.fork(), sql, args);
  // Assert exact SQLSTATE inside PostgreSQL, using SQL that bypasses the application.
  const guarded = (sql: string, code: string, args: unknown[] = [wallet.id]) =>
    run(`do $guard$ begin
      ${sql};
      raise exception 'write unexpectedly succeeded';
      exception when sqlstate '${code}' then null;
    end $guard$`, args);
  await guarded('update wallet set balance = -1 where id = ?', '23514');
  await guarded('update wallet set balance = 1.001 where id = ?', '23514');
  await guarded('update wallet set balance = 10000000000000000 where id = ?', '23514');
  await guarded("update wallet set balance = 'NaN' where id = ?", '23514');
  await guarded('insert into wallet(id, player_id,currency,balance,version) select ?,player_id,currency,balance,version from wallet where id=?',
    '23505', [randomUUID(), wallet.id]);
  await guarded('update ledger set amount = 1 where wallet_id = ?', '55000');
  await guarded('delete from ledger where wallet_id = ?', '55000');
  await guarded('truncate ledger', '55000', []);
  await guarded(`insert into ledger(id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
    select ?, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after from ledger where wallet_id = ?`,
    '23505', [randomUUID(), wallet.id]);
  const provider = ids().providerId;
  const loss = await api.submit(wagerFrom({ providerId: provider, playerId, walletId: wallet.id,
    externalTransactionId: 'loss', roundId: 'round', gameId: 'game', kind: 'LOSS', money: dto('0') }), 'loss');
  await guarded(`insert into ledger(id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
    values (?, ?, ?, 'CREDIT', '1.00', 'BRL', '100.00', '102.00')`, '23514', [randomUUID(), wallet.id, loss!.transactionId]);
  await guarded(`insert into ledger(id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
    values (?, ?, ?, 'CREDIT', '1.00', 'BRL', '100.00', '101.00')`, '23514', [randomUUID(), wallet.id, loss!.transactionId]);
  await checkLedger(db, wallet.id, '100.00');
  await run("update wallet set balance = '101.00' where id = ?");
  expect(await api.reconcile(wallet.id)).toMatchObject({ consistent: false, difference: dto('1.00') });
  await run("update wallet set balance = '100.00' where id = ?");
  await checkLedger(db, wallet.id, '100.00');
}, 20000);

test('outbox failure rolls back financial state and inbox; committed retry and inbox redelivery are safe', async () => {
  const { db } = connection;
  const api = new Wagering(db);
  const { providerId, playerId } = ids();
  const wallet = await api.open(playerId, Money.from(dto('100')));
  const input = wagerFrom({ providerId, playerId, walletId: wallet.id, externalTransactionId: 'bet',
    roundId: 'round', gameId: 'game', kind: 'BET', money: dto('80') });
  const messageId = randomUUID();
  const em = db.em.fork();
  await query(em, `create or replace function test_fail_balance_event() returns trigger language plpgsql as $$
    begin raise exception 'injected failure'; end $$;
    create trigger test_fail_balance_event before insert on outbox for each row
    when (new.event_type = 'WalletBalanceChanged' and new.aggregate_id = ?) execute function test_fail_balance_event()`, [wallet.id]);
  try {
    const failure = await api.submit(input, 'bet', InboxMessage.receive(messageId, hash('same'))).catch(error => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.code).toBe('P0001');
    expect(await query(em, 'select 1 from inbox where message_id = ?', [messageId])).toEqual([]);
    expect(await query(em, 'select 1 from wager where provider_id = ?', [providerId])).toEqual([]);
    await checkLedger(db, wallet.id, '100.00');
  } finally {
    await query(em, 'drop trigger test_fail_balance_event on outbox; drop function test_fail_balance_event()');
  }
  const result = await api.submit(input, 'bet', InboxMessage.receive(messageId, hash('same')));
  expect(result?.status).toBe('PROCESSED');
  expect(await api.submit(input, 'bet', InboxMessage.receive(messageId, hash('same')))).toBeNull();
  const inboxConflict = await api.submit(input, 'bet', InboxMessage.receive(messageId, hash('different'))).catch(error => error);
  const externalConflict = await api.submit(input, 'other-key').catch(error => error);
  expect(inboxConflict).toMatchObject({ code: 'INBOX_PAYLOAD_CONFLICT' });
  expect(externalConflict).toMatchObject({ code: 'EXTERNAL_ID_CONFLICT' });
  expect(await query(em, 'select processed_at from inbox where message_id = ?', [messageId])).toEqual([
    { processed_at: expect.any(String) },
  ]);
  expect(await query(em, 'select id from outbox where aggregate_id = ?', [result!.transactionId])).toHaveLength(1);
  await checkLedger(db, wallet.id, '20.00');
});

test('a transaction is reversed at most once across kinds; historical replay and overdrawing reversal', async () => {
  const { db } = connection;
  const api = new Wagering(db);
  const { providerId, playerId } = ids();
  const wallet = await api.open(playerId, Money.from(dto('100')));
  const submit = (id: string, kind: string, amount: string, referenceExternalTransactionId?: string) => api.submit(
    wagerFrom({ providerId, playerId, walletId: wallet.id, externalTransactionId: id, roundId: 'round',
      gameId: 'game', kind, money: dto(amount), referenceExternalTransactionId }), id);
  const bet = await submit('bet', 'BET', '60');
  const refund = await submit('refund', 'REFUND', '60', 'bet');
  expect(refund?.balance).toEqual(dto('100.00'));
  expect(await submit('refund-duplicate', 'REFUND', '60', 'bet')).toMatchObject({ failureCode: 'ALREADY_REVERSED' });
  // A ROLLBACK of the already refunded BET would credit the same 60.00 a second time.
  expect(await submit('rollback-bet', 'ROLLBACK', '60', 'bet')).toMatchObject({
    status: 'REJECTED', failureCode: 'ALREADY_REVERSED', balance: dto('100.00') });
  // The schema enforces the same rule without the application.
  await query(db.em.fork(), `do $guard$ begin
      insert into wager select ?::uuid, provider_id, 'rollback-sql', 'rollback-sql',
        payload_hash, wallet_id, player_id, round_id, game_id, 'ROLLBACK', amount, currency, reference_external_id,
        reference_id, status, failure_code, observed_balance, attempts, next_attempt_at, causation_id, created_at, processed_at
      from wager where id = ?;
      raise exception 'write unexpectedly succeeded';
      exception when sqlstate '23505' then null;
    end $guard$`, [randomUUID(), refund!.transactionId]);
  // Undoing the REFUND itself is a different reference and stays allowed, once.
  expect((await submit('rollback-refund', 'ROLLBACK', '60', 'refund'))?.balance).toEqual(dto('40.00'));
  expect(await submit('rollback-refund-again', 'ROLLBACK', '60', 'refund')).toMatchObject({
    status: 'REJECTED', failureCode: 'ALREADY_REVERSED' });
  expect(await submit('bet', 'BET', '60')).toMatchObject({ transactionId: bet!.transactionId,
    idempotentReplay: true, balance: dto('40.00') });
  expect((await submit('win', 'WIN', '50', 'bet'))?.status).toBe('PROCESSED');
  expect((await submit('spend', 'BET', '80'))?.status).toBe('PROCESSED');
  expect(await submit('rollback-win', 'ROLLBACK', '50', 'win')).toMatchObject({
    status: 'REJECTED', failureCode: 'REVERSAL_INSUFFICIENT_FUNDS' });
  expect(await submit('loss', 'LOSS', '0')).toMatchObject({ status: 'PROCESSED' });
  expect(await checkLedger(db, wallet.id, '10.00')).toHaveLength(6);
});

test('reference expiration emits one rejection and a terminal reference is rejected immediately', async () => {
  const { db } = connection;
  const api = new Wagering(db);
  const { providerId, playerId } = ids();
  const wallet = await api.open(playerId, Money.zero('BRL'));
  const em = db.em.fork();
  const submit = (externalTransactionId: string, kind: string, referenceExternalTransactionId?: string) => api.submit(
    wagerFrom({ providerId, playerId, walletId: wallet.id, externalTransactionId, roundId: 'round', gameId: 'game',
      kind, money: dto('1'), referenceExternalTransactionId }), externalTransactionId);
  const pending = await submit('refund', 'REFUND', 'missing');
  expect(pending?.status).toBe('PENDING_REFERENCE');
  await query(em, 'update wager set attempts = 9, next_attempt_at = now() where id = ?', [pending!.transactionId]);
  expect(await api.retryOne()).toBe(true);
  expect(await submit('refund', 'REFUND', 'missing')).toMatchObject({
    status: 'REJECTED', failureCode: 'REFERENCE_EXPIRED', idempotentReplay: true,
  });
  expect(await query(em, 'select event_type from outbox where aggregate_id = ? order by occurred_at', [pending!.transactionId]))
    .toEqual([{ event_type: 'WagerTransactionPendingReference' }, { event_type: 'WagerTransactionRejected' }]);
  expect(await submit('bet', 'BET')).toMatchObject({ failureCode: 'INSUFFICIENT_FUNDS' });
  expect(await submit('late-refund', 'REFUND', 'bet')).toMatchObject({
    status: 'REJECTED', failureCode: 'REFERENCE_NOT_PROCESSED',
  });
  await checkLedger(db, wallet.id, '0.00');
});

test('a failed pending reference is deferred and another wallet progresses', async () => {
  const { db } = connection;
  const api = new Wagering(db);
  const em = db.em.fork();
  const amount = Money.from(dto('1'));
  const fixtures = [];
  for (const delay of [10, 5]) {
    const { playerId, providerId } = ids();
    const wallet = await api.open(playerId, amount);
    const base = { walletId: wallet.id, playerId, providerId, roundId: 'round', gameId: 'game' };
    const pending = await api.submit(wagerFrom({ ...base, externalTransactionId: 'refund', kind: 'REFUND',
      money: dto('1'), referenceExternalTransactionId: 'bet' }), 'refund');
    await api.submit(wagerFrom({ ...base, externalTransactionId: 'bet', kind: 'BET', money: dto('1') }), 'bet');
    await query(em, "update wager set next_attempt_at = now() - ?::int * interval '1 second' where id = ?",
      [delay, pending!.transactionId]);
    fixtures.push({ walletId: wallet.id, id: pending!.transactionId });
  }
  const [broken, healthy] = fixtures;
  await query(em, `create function test_fail_reference_event() returns trigger language plpgsql as $$
    begin raise exception 'injected reference failure'; end $$;
    create trigger test_fail_reference_event before insert on outbox for each row
    when (new.aggregate_id = ? and new.event_type = 'WagerTransactionProcessed')
    execute function test_fail_reference_event()`, [broken.id]);
  try {
    expect(await api.retryOne()).toBe(true);
    expect(await api.retryOne()).toBe(true);
    expect((await api.getTransaction(broken.id)).status).toBe('PENDING_REFERENCE');
    expect((await api.getTransaction(healthy.id)).status).toBe('PROCESSED');
    await checkLedger(db, broken.walletId, '0.00');
    await checkLedger(db, healthy.walletId, '1.00');
  } finally {
    await query(em, 'drop trigger test_fail_reference_event on outbox; drop function test_fail_reference_event()');
  }
  await query(em, 'update wager set next_attempt_at = now() where id = ?', [broken.id]);
  expect(await api.retryOne()).toBe(true);
  await checkLedger(db, broken.walletId, '1.00');
});

test('a permanent write error records FAILED after rolling back the entire financial attempt', async () => {
  const { db } = connection;
  const api = new Wagering(db);
  const em = db.em.fork();
  const { playerId, providerId } = ids();
  const wallet = await api.open(playerId, Money.from(dto('100')));
  const base = { walletId: wallet.id, playerId, providerId, roundId: 'round', gameId: 'game', money: dto('80') };
  const refund = wagerFrom({ ...base, externalTransactionId: 'refund', kind: 'REFUND', referenceExternalTransactionId: 'bet' });
  const pending = await api.submit(refund, 'refund');
  expect(pending?.status).toBe('PENDING_REFERENCE');
  await api.submit(wagerFrom({ ...base, externalTransactionId: 'bet', kind: 'BET' }), 'bet');
  await query(em, 'update wager set next_attempt_at = now() where id = ?', [pending!.transactionId]);
  const before = await api.getWallet(wallet.id);
  const outboxBefore = await query(em, 'select id from outbox order by id');

  // The wallet, ledger and processed event have already been written when this trigger runs.
  await query(em, `create function test_permanent_reference_write() returns trigger language plpgsql as $$
    begin raise exception 'injected constraint violation' using errcode = '23514'; end $$;
    create trigger test_permanent_reference_write before insert on outbox for each row
    when (new.event_type = 'WalletBalanceChanged' and new.payload->'data'->>'transactionId' = ?)
    execute function test_permanent_reference_write()`, [pending!.transactionId]);
  try {
    expect(await api.retryOne()).toBe(true);
    expect(await api.getTransaction(pending!.transactionId)).toMatchObject({
      status: 'FAILED', failureCode: 'PERMANENT_PERSISTENCE_ERROR', balance: dto('20.00'),
    });
    expect(await api.getWallet(wallet.id)).toEqual(before);
    expect(await checkLedger(db, wallet.id, '20.00')).toHaveLength(2);
    expect(await query(em, 'select id from outbox order by id')).toEqual(outboxBefore);
    expect(await query(em, 'select next_attempt_at, processed_at from wager where id = ?', [pending!.transactionId]))
      .toEqual([{ next_attempt_at: null, processed_at: null }]);
  } finally {
    await query(em, 'drop trigger test_permanent_reference_write on outbox; drop function test_permanent_reference_write()');
  }
  expect(await api.retryOne()).toBe(false);
  expect(await api.submit(refund, 'refund')).toMatchObject({
    transactionId: pending!.transactionId, status: 'FAILED', idempotentReplay: true, balance: dto('20.00'),
  });
  await checkLedger(db, wallet.id, '20.00');
});
