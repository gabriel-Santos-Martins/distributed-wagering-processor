import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { query } from '../src/database';
import { Money } from '../src/domain';
import { Wagering } from '../src/wagering';
import { checkLedger, dto, eventually, ids, request, send, setup } from './support';

let connection: Awaited<ReturnType<typeof setup>>;
const children = new Map<number, ReturnType<typeof Bun.spawn>>();
const ports = [34101, 34102, 34103];
const submitPath = '/wagering/transactions';
const postgresOnly = process.env.TEST_POSTGRES_ONLY === '1';
const brokerTest = postgresOnly ? test.skip : test;

async function start(port: number, crashPoint?: string, target?: string) {
  const child = Bun.spawn([process.execPath, 'test/child.cjs'], {
    env: { ...process.env, PORT: String(port), DISABLE_WORKERS: '0', TEST_CRASH_POINT: crashPoint, TEST_CRASH_TARGET: target },
    stdout: 'ignore', stderr: 'inherit',
    ipc: () => {},
  });
  children.set(port, child);
  if (crashPoint !== 'publish' && crashPoint !== 'mark') {
    await eventually(() => request(port, postgresOnly ? '/health/live' : '/health/ready'), value => value.status === 200);
  }
  return child;
}
async function stop(port: number) {
  const child = children.get(port);
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) child.send('stop');
  const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(22000).then(() => false)]);
  if (!exited) child.kill('SIGKILL');
  await child.exited;
  children.delete(port);
}
async function cluster() { await Promise.all(ports.map(port => start(port))); }

beforeAll(async () => { connection = await setup(!postgresOnly); await cluster(); }, 30000);
afterAll(async () => {
  await Promise.all([...children.keys()].map(stop));
  await connection?.db.close();
  connection?.queues.client.destroy();
}, 30000);

brokerTest('exhausted SQS deliveries reach the DLQ without financial effects', async () => {
  const { db, queues } = connection;
  const { walletId, wager } = await fixture();
  const payload = wager('exhausted');
  const em = db.em.fork();
  const messageId = randomUUID();
  await query(em, `create function test_fail_exhausted_sqs() returns trigger language plpgsql as $$
    begin raise exception 'injected persistent insert failure'; end $$;
    create trigger test_fail_exhausted_sqs before insert on wager for each row
    when (new.provider_id = ?) execute function test_fail_exhausted_sqs()`, [payload.providerId]);
  try {
    await send(queues, walletId, { ...payload, idempotencyKey: 'exhausted' }, messageId);
    const terminal = await eventually(async () => {
      const { Messages = [] } = await queues.client.send(new ReceiveMessageCommand({
        QueueUrl: queues.dlq, WaitTimeSeconds: 1, MaxNumberOfMessages: 10, MessageAttributeNames: ['All'],
      }));
      for (const message of Messages) {
        if (JSON.parse(message.Body!).messageId !== messageId) continue;
        await queues.client.send(new DeleteMessageCommand({ QueueUrl: queues.dlq, ReceiptHandle: message.ReceiptHandle }));
        return message.MessageAttributes?.failureCode?.StringValue;
      }
    }, code => code !== undefined, 48000);
    expect(terminal).toBe('DELIVERY_EXHAUSTED');
    expect(await query(em, 'select 1 from inbox where message_id = ?', [messageId])).toHaveLength(0);
    expect(await query(em, 'select 1 from wager where provider_id = ?', [payload.providerId])).toHaveLength(0);
    expect(await checkLedger(db, walletId, '100.00')).toHaveLength(1);
  } finally {
    await query(em, 'drop trigger test_fail_exhausted_sqs on wager; drop function test_fail_exhausted_sqs()');
  }
}, 55000);

brokerTest('permanent financial write failure commits FAILED before SQS DLQ and HTTP replay', async () => {
  const { db, queues } = connection;
  const { walletId, wager } = await fixture();
  const payload = wager('permanent');
  const em = db.em.fork();
  const messageId = randomUUID();
  await query(em, `create function test_permanent_sqs_write() returns trigger language plpgsql as $$
    begin raise exception 'injected permanent constraint failure' using errcode = '23514'; end $$;
    create trigger test_permanent_sqs_write before insert on outbox for each row
    when (new.event_type = 'WalletBalanceChanged' and new.aggregate_id = ?)
    execute function test_permanent_sqs_write()`, [walletId]);
  try {
    await send(queues, walletId, { ...payload, idempotencyKey: 'permanent' }, messageId);
    const readFailedMessage = () => eventually(async () => {
      const { Messages = [] } = await queues.client.send(new ReceiveMessageCommand({
        QueueUrl: queues.dlq, WaitTimeSeconds: 1, MaxNumberOfMessages: 10, MessageAttributeNames: ['All'],
      }));
      return Messages.find(message => JSON.parse(message.Body!).messageId === messageId);
    }, Boolean);
    const failedMessage = await readFailedMessage();
    expect(failedMessage?.MessageAttributes?.failureCode?.StringValue).toBe('PERMANENT_PERSISTENCE_ERROR');
    await queues.client.send(new DeleteMessageCommand({ QueueUrl: queues.dlq, ReceiptHandle: failedMessage?.ReceiptHandle }));
    expect(await query(em, 'select 1 from inbox where message_id = ? and processed_at is not null', [messageId]))
      .toHaveLength(1);
    expect(await query(em, "select 1 from outbox where payload->>'causationId' = ?", [messageId])).toHaveLength(0);
    const replay = await request(ports[1], submitPath, payload, 'permanent');
    expect(replay).toMatchObject({
      status: 500, body: { status: 'FAILED', failureCode: 'PERMANENT_PERSISTENCE_ERROR',
        idempotentReplay: true, balance: dto('100.00') },
    });
    // A fresh transport message bypasses FIFO dedup while preserving the inbox envelope exactly.
    await queues.client.send(new SendMessageCommand({ QueueUrl: queues.input, MessageGroupId: walletId,
      MessageDeduplicationId: randomUUID(), MessageBody: failedMessage?.Body }));
    const redelivered = await readFailedMessage();
    expect(redelivered?.MessageAttributes?.failureCode?.StringValue).toBe('PERMANENT_PERSISTENCE_ERROR');
    await queues.client.send(new DeleteMessageCommand({ QueueUrl: queues.dlq, ReceiptHandle: redelivered?.ReceiptHandle }));
    expect(await query(em, 'select 1 from wager where provider_id = ?', [payload.providerId])).toHaveLength(1);
    expect(await checkLedger(db, walletId, '100.00')).toHaveLength(1);
  } finally {
    await query(em, 'drop trigger test_permanent_sqs_write on outbox; drop function test_permanent_sqs_write()');
  }
}, 20000);

async function fixture(amount = '100.00', port = ports[0]) {
  const identity = ids();
  const result = await request(port, '/wallets', { playerId: identity.playerId, initialBalance: dto(amount) });
  expect(result.status).toBe(201);
  const walletId: string = result.body.id;
  const wager = (externalTransactionId: string, amount = '80', kind = 'BET', referenceExternalTransactionId?: string) =>
    ({ ...identity, walletId, externalTransactionId, kind, referenceExternalTransactionId, money: dto(amount),
      gameId: 'fortune-chimp', roundId: 'round' });
  return { walletId, wager };
}
const debitCount = (rows: { direction: string }[]) => rows.filter(row => row.direction === 'DEBIT').length;

test('50 parallel HTTP submissions across three processes debit once' +
  (postgresOnly ? '' : ' while racing with SQS'), async () => {
  const { db, queues } = connection;
  const { walletId, wager } = await fixture();
  const payload = wager('same');
  const results = await Promise.all([
    postgresOnly ? undefined : send(queues, walletId, { ...payload, idempotencyKey: 'same' }),
    Promise.all(Array.from({ length: 50 }, (_, i) => request(ports[i % ports.length], submitPath, payload, 'same'))),
  ]);
  const [messageId, http] = results;
  expect(http.every(result => result.status === 200)).toBe(true);
  expect(new Set(http.map(result => result.body.transactionId)).size).toBe(1);
  expect(http.filter(result => !result.body.idempotentReplay).length).toBeLessThanOrEqual(1);
  expect(http.every(result => result.body.balance.amount === '20.00')).toBe(true);
  if (messageId) await eventually(
    () => query(db.em.fork(), 'select 1 from inbox where message_id = ? and processed_at is not null', [messageId]),
    rows => rows.length === 1);
  expect((await request(ports[0], submitPath, wager('same', '81'), 'same')).status).toBe(409);
  const first = await request(ports[0], '/wallets/' + walletId + '/ledger?limit=1');
  const second = await request(ports[1], '/wallets/' + walletId + '/ledger?limit=1&cursor=' + first.body.nextCursor);
  expect(first.body.entries[0].direction).toBe('CREDIT');
  expect(second.body.entries[0].direction).toBe('DEBIT');
  expect(second.body.nextCursor).toBeNull();
  expect(debitCount(await checkLedger(db, walletId, '20.00'))).toBe(1);
}, 25000);

test('two BETs compete for 100.00; an independently locked wallet does not block another wallet', async () => {
  const { db } = connection;
  const a = await fixture();
  const b = await fixture();
  const em = db.em.fork();
  await em.transactional(async transaction => {
    await query(transaction, 'select id from wallet where id = ? for update', [a.walletId]);
    const pending = request(ports[0], submitPath, a.wager('a1'), 'a1');
    const competing = request(ports[1], submitPath, a.wager('a2'), 'a2');
    await eventually(() => query<{ count: number }>(em,
      "select count(*)::int as count from pg_stat_activity where wait_event_type = 'Lock' and query like '%from wallet%for update%'"),
      rows => rows[0].count >= 2, 3500);
    const parallel = await request(ports[2], submitPath, b.wager('b'), 'b');
    expect(parallel.status).toBe(200);
    return { pending, competing };
  }).then(async ({ pending, competing }) => {
    const results = await Promise.all([pending, competing]);
    expect(results.map(result => result.status).sort()).toEqual([200, 422]);
    expect(results.find(result => result.status === 422)?.body.failureCode).toBe('INSUFFICIENT_FUNDS');
  });
  expect(debitCount(await checkLedger(db, a.walletId, '20.00'))).toBe(1);
  await checkLedger(db, b.walletId, '20.00');
}, 15000);

test('out-of-order REFUND reaches PROCESSED and pending replay advances to final outcome', async () => {
  const { db, queues } = connection;
  const { walletId, wager } = await fixture();
  const refund = wager('refund', '80', 'REFUND', 'bet');
  if (postgresOnly) expect((await request(ports[0], submitPath, refund, 'refund')).status).toBe(202);
  else await send(queues, walletId, { ...refund, idempotencyKey: 'refund' });
  await eventually(() => request(ports[1], '/providers/' + refund.providerId + '/wagering/transactions/refund'),
    value => value.body.status === 'PENDING_REFERENCE');
  expect((await request(ports[1], submitPath, refund, 'refund')).status).toBe(202);
  expect((await request(ports[2], submitPath, wager('bet'), 'bet')).status).toBe(200);
  await eventually(() => request(ports[1], submitPath, refund, 'refund'),
    value => value.status === 200 && value.body.idempotentReplay === true);
  await checkLedger(db, walletId, '100.00');
}, 20000);

brokerTest('crash after commit before ack triggers broker redelivery and inbox dedup after restart', async () => {
  const { db, queues } = connection;
  await Promise.all(ports.map(stop));
  const api = new Wagering(db);
  const { providerId, playerId } = ids();
  const wallet = await api.open(playerId, Money.from(dto('100')));
  const payload = { providerId, playerId, walletId: wallet.id, externalTransactionId: 'bet',
    roundId: 'round', gameId: 'game', kind: 'BET', money: dto('80'), idempotencyKey: 'bet' };
  const messageId = randomUUID();
  const crashing = await start(ports[0], 'ack', messageId);
  await send(queues, wallet.id, payload, messageId);
  await eventually(async () => crashing.exitCode ?? crashing.signalCode, value => value !== null && value !== undefined);
  await checkLedger(db, wallet.id, '20.00');
  await cluster();
  await eventually(async () => Promise.all(ports.map(port => request(port, '/metrics'))),
    results => results.some(result => result.body.inbox_duplicates_total >= 1), 75000);
  expect(await query(db.em.fork(), 'select 1 from inbox where message_id = ? and processed_at is not null', [messageId]))
    .toHaveLength(1);
  expect(debitCount(await checkLedger(db, wallet.id, '20.00'))).toBe(1);
}, 120000);

brokerTest('publisher crashes before send, then after send; two restarted publishers recover with stable eventId', async () => {
  const { db, queues } = connection;
  await Promise.all(ports.map(stop));
  const wallet = await new Wagering(db).open(ids().playerId, Money.from(dto('7')));
  const em = db.em.fork();
  const events = await query<{ id: string; published_at: string | null }>(em,
    'select id, published_at from outbox where aggregate_id = ?', [wallet.id]);
  const target = events[0].id;
  const inspect = () => query<{ published_at: string | null }>(em, 'select published_at from outbox where id = ?', [target]);
  const beforeSend = await start(ports[0], 'publish', target);
  await eventually(async () => beforeSend.exitCode ?? beforeSend.signalCode, value => value != null);
  expect((await inspect())[0].published_at).toBeNull();
  const afterSend = await start(ports[0], 'mark', target);
  await eventually(async () => afterSend.exitCode ?? afterSend.signalCode, value => value != null);
  expect((await inspect())[0].published_at).toBeNull();
  await Promise.all(ports.slice(0, 2).map(port => start(port)));
  await eventually(inspect, value => value[0].published_at !== null);
  let matches = 0;
  await eventually(async () => {
    const { Messages = [] } = await queues.client.send(new ReceiveMessageCommand({
      QueueUrl: queues.events, MaxNumberOfMessages: 10, WaitTimeSeconds: 1,
    }));
    for (const msg of Messages) {
      if (JSON.parse(msg.Body!).eventId === target) matches++;
      await queues.client.send(new DeleteMessageCommand({ QueueUrl: queues.events, ReceiptHandle: msg.ReceiptHandle }));
    }
    return matches;
  }, count => count >= 2);
  await checkLedger(db, wallet.id, '7.00');
  await start(ports[2]);
}, 65000);

brokerTest('permanent malformed input reaches DLQ; transient SQL failure backs off and later succeeds', async () => {
  const { db, queues } = connection;
  const bad = randomUUID();
  await send(queues, bad, {}, bad);
  await eventually(async () => {
    const { Messages = [] } = await queues.client.send(new ReceiveMessageCommand({ QueueUrl: queues.dlq,
      MaxNumberOfMessages: 10, WaitTimeSeconds: 1, MessageAttributeNames: ['All'] }));
    let result = false;
    for (const msg of Messages) {
      if (JSON.parse(msg.Body!).messageId === bad) {
        expect(msg.MessageAttributes?.failureCode.StringValue).toBe('INVALID_PROVIDER');
        result = true;
      }
      await queues.client.send(new DeleteMessageCommand({ QueueUrl: queues.dlq, ReceiptHandle: msg.ReceiptHandle }));
    }
    return result;
  }, Boolean);

  const { walletId, wager } = await fixture();
  const em = db.em.fork();
  const pending = await em.transactional(async context => {
    await query(context, 'select id from wallet where id = ? for update', [walletId]);
    const id = await send(queues, walletId, { ...wager('retry'), idempotencyKey: 'retry' });
    await eventually(async () => Promise.all(ports.map(port => request(port, '/metrics'))),
      result => result.some(response => response.body.message_retries_total >= 1), 10000);
    return id;
  });
  await eventually(() => query(em, 'select 1 from inbox where message_id = ?', [pending]), value => value.length === 1);
  await checkLedger(db, walletId, '20.00');
}, 35000);

brokerTest('a pre-commit outbox fault rolls back the SQS inbox and redelivery commits once', async () => {
  const { db, queues } = connection;
  const { walletId, wager } = await fixture();
  const payload = wager('atomic');
  const em = db.em.fork();
  const messageId = randomUUID();
  const retries = async () => (await Promise.all(ports.map(port => request(port, '/metrics'))))
    .reduce((total, response) => total + (response.body.message_retries_total ?? 0), 0);
  const initialRetries = await retries();
  await query(em, `create function test_fail_sqs_balance_event() returns trigger language plpgsql as $$
    begin raise exception 'injected SQS outbox failure'; end $$;
    create trigger test_fail_sqs_balance_event before insert on outbox for each row
    when (new.event_type = 'WalletBalanceChanged' and new.aggregate_id = ?)
    execute function test_fail_sqs_balance_event()`, [walletId]);
  try {
    await send(queues, walletId, { ...payload, idempotencyKey: 'atomic' }, messageId);
    await eventually(retries, value => value > initialRetries);
    expect(await query(em, 'select 1 from inbox where message_id = ?', [messageId])).toHaveLength(0);
    expect(await query(em, 'select 1 from wager where provider_id = ?', [payload.providerId])).toHaveLength(0);
    expect(await query(em, 'select 1 from outbox where payload->>\'causationId\' = ?', [messageId])).toHaveLength(0);
    expect(await checkLedger(db, walletId, '100.00')).toHaveLength(1);
  } finally {
    await query(em, 'drop trigger test_fail_sqs_balance_event on outbox; drop function test_fail_sqs_balance_event()');
  }
  await eventually(() => query(em, 'select 1 from inbox where message_id = ? and processed_at is not null', [messageId]),
    result => result.length === 1);
  expect(await query(em, 'select 1 from wager where provider_id = ? and status = ?', [payload.providerId, 'PROCESSED']))
    .toHaveLength(1);
  expect(await query(em, 'select 1 from outbox where payload->>\'causationId\' = ?', [messageId])).toHaveLength(2);
  expect(debitCount(await checkLedger(db, walletId, '20.00'))).toBe(1);
}, 30000);
