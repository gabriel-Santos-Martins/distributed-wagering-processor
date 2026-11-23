import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { connect, query, type Database } from '../src/infrastructure/persistence/database';
import { Queues } from '../src/infrastructure/messaging/sqs';

export const baseUrl = (port: number) => 'http://127.0.0.1:' + port;
export const dto = (amount: string) => ({ amount, currency: 'BRL' });
export const ids = () => ({ providerId: 'provider-' + randomUUID(), playerId: randomUUID() });

export async function setup(requireQueues = true) {
  const db = await connect();
  try {
    const queues = new Queues();
    await db.getMigrator().up();
    if (requireQueues) await queues.ready();
    return { db, queues };
  } catch (error) {
    await db.close();
    throw error;
  }
}

export async function checkLedger(db: Database, walletId: string, expected?: string) {
  const [wallet] = await query<{ balance: string }>(db.em.fork(), 'select balance::text from wallet where id = ?', [walletId]);
  const rows = await query<{ amount: string; balance_before: string; balance_after: string; direction: string }>(db.em.fork(),
    'select amount::text, balance_before::text, balance_after::text, direction from ledger where wallet_id = ? order by sequence',
    [walletId]);
  const cents = (value: string) => {
    const [integer, fraction = ''] = value.split('.');
    return BigInt(integer) * 100n + BigInt(fraction.padEnd(2, '0'));
  };
  let sum = 0n;
  for (const row of rows) {
    expect(cents(row.balance_before)).toBe(sum);
    sum += (row.direction === 'CREDIT' ? 1n : -1n) * cents(row.amount);
    expect(cents(row.balance_after)).toBe(sum);
  }
  expect(cents(wallet.balance)).toBe(sum);
  if (expected !== undefined) expect(sum).toBe(cents(expected));
  return rows;
}

export async function eventually<T>(read: () => Promise<T>, acceptable: (value: T) => boolean, timeout = 12000) {
  const end = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const value = await read();
      if (acceptable(value)) return value;
      last = value;
    } catch (error) { last = error; }
    await Bun.sleep(100);
  }
  throw new Error('Condition did not converge', { cause: last });
}

export async function request(port: number, path: string, body?: unknown, key?: string) {
  const response = await fetch(baseUrl(port) + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(key === undefined ? {} : { 'Idempotency-Key': key }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  return { status: response.status, body: await response.json() };
}

export async function send(queues: Queues, group: string, data: unknown, messageId = randomUUID()) {
  await queues.client.send(new SendMessageCommand({ QueueUrl: queues.input,
    MessageGroupId: group, MessageDeduplicationId: randomUUID(),
    MessageBody: JSON.stringify({ messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data }) }));
  return messageId;
}
