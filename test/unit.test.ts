import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { wagerFrom, wagerHash } from '../src/contracts';
import { BusinessRuleViolation, DomainError, FailureCode, InboxMessage, InvalidTransactionStateError, Money,
  OutboxMessage, Wallet, WalletBalanceChanged, WalletLedgerEntry, WagerTransaction, WagerTransactionProcessed,
  WagerTransactionRejected, type WagerInput } from '../src/domain';

const brl = (amount: string, allowNegative = false) => Money.from({ amount, currency: 'BRL' }, allowNegative);
const template: WagerInput = { providerId: 'provider', externalTransactionId: 'bet', gameId: 'game', roundId: 'round',
  walletId: randomUUID(), playerId: randomUUID(), kind: 'BET', money: brl('8') };
const at = new Date('2026-07-29T15:00:00.000Z');

function wager(overrides: Partial<WagerInput>) {
  const input = { ...template, ...overrides };
  return WagerTransaction.create({ ...input, id: randomUUID(), idempotencyKey: input.externalTransactionId,
    payloadHash: wagerHash(input) });
}
function processed(overrides: Partial<WagerInput>) {
  const tx = wager(overrides);
  tx.markProcessed(undefined, at);
  return tx;
}
const movement = (amount: string) => ({ entryId: randomUUID(), transactionId: randomUUID(), money: brl(amount), at });

describe('Money', () => {
  test.each(['', ' ', 'NaN', 'Infinity', '2e3', '-1', '-0.00', '1.234', '10000000000000000', '.5', '1\n', '1.'])(
    'rejects invalid amount %j', value => expect(() => brl(value)).toThrow(DomainError));
  test('adds, subtracts, normalizes and preserves precision above binary64 safe range', () => {
    const amount = brl('9007199254740993.1');
    expect(amount.add(brl('0.19')).toJSON()).toEqual({ amount: '9007199254740993.29', currency: 'BRL' });
    expect(amount.toJSON().amount).toBe('9007199254740993.10');
    expect(brl('0').subtract(brl('0.01')).equals(brl('-0.01', true))).toBe(true);
    expect(() => brl('9999999999999999.99').add(brl('0.01'))).toThrow('AMOUNT_LIMIT');
    expect(() => brl('1').add(Money.zero('USD'))).toThrow('CURRENCY_MISMATCH');
    expect(Object.isFrozen(amount)).toBe(true);
  });
  test('comparisons, sign queries and string form', () => {
    expect(brl('1').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.01').isLessThan(brl('1'))).toBe(false);
    expect(() => brl('1').isLessThan(Money.zero('USD'))).toThrow('CURRENCY_MISMATCH');
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0').isPositive()).toBe(false);
    expect(brl('0').isZero()).toBe(true);
    expect(brl('-0.01', true).isNegative()).toBe(true);
    expect(brl('25').toString()).toBe('25.00 BRL');
  });
});

describe('Wallet', () => {
  test('debit and credit return the ledger entry and keep balance, version and ledger consistent', () => {
    const initial = brl('100');
    const wallet = Wallet.open({ id: template.walletId, playerId: template.playerId, initialBalance: initial, at });
    expect(wallet.version).toBe(1);
    expect(wallet.currency).toBe('BRL');
    const opening = wallet.openingEntry({ entryId: randomUUID(), transactionId: randomUUID() })!;
    expect(opening).toMatchObject({ direction: 'CREDIT' });
    expect(opening.balanceAfter.equals(initial)).toBe(true);
    expect(() => wallet.debit(movement('100.01'))).toThrow('INSUFFICIENT_FUNDS');
    expect(() => wallet.debit(movement('100.01'), FailureCode.ReversalInsufficientFunds))
      .toThrow(new BusinessRuleViolation(FailureCode.ReversalInsufficientFunds));
    expect(() => wallet.credit({ ...movement('0'), money: Money.zero('USD') })).toThrow('CURRENCY_MISMATCH');
    expect(wallet.credit(movement('0'))).toBeUndefined();
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);

    const later = new Date(at.getTime() + 1000);
    const debit = wallet.debit({ ...movement('80'), at: later })!;
    expect(debit.isBalanced()).toBe(true);
    expect(Object.isFrozen(debit)).toBe(true);
    expect(debit).toMatchObject({ direction: 'DEBIT', walletId: wallet.id });
    expect(debit.balanceBefore.equals(initial)).toBe(true);
    expect(debit.balanceAfter.equals(wallet.balance)).toBe(true);
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(later);
    const credit = wallet.credit(movement('5'))!;
    expect(wallet.version).toBe(3);
    const ledger = [opening, debit, credit].reduce((sum, entry) =>
      entry.direction === 'CREDIT' ? sum.add(entry.money) : sum.subtract(entry.money), Money.zero('BRL'));
    expect(ledger.equals(wallet.balance)).toBe(true);
    expect(() => wallet.openingEntry({ entryId: randomUUID(), transactionId: randomUUID() })).toThrow();
  });

  test('rejects another player or currency, negative opening, and keeps the empty opening without entry', () => {
    const wallet = Wallet.open({ id: randomUUID(), playerId: template.playerId, initialBalance: brl('0') });
    expect(wallet.openingEntry({ entryId: randomUUID(), transactionId: randomUUID() })).toBeUndefined();
    expect(() => wallet.assertAccepts(randomUUID(), brl('1'))).toThrow('PLAYER_WALLET_MISMATCH');
    expect(() => wallet.assertAccepts(template.playerId, Money.zero('USD'))).toThrow('CURRENCY_MISMATCH');
    wallet.assertAccepts(template.playerId, brl('1'));
    expect(() => Wallet.open({ id: randomUUID(), playerId: template.playerId, initialBalance: brl('-1', true) }))
      .toThrow('INVALID_OPENING_BALANCE');
    const state = { id: randomUUID(), walletId: wallet.id, transactionId: randomUUID(), direction: 'DEBIT' as const,
      money: brl('80'), balanceBefore: brl('100'), balanceAfter: brl('20'), createdAt: at };
    expect(WalletLedgerEntry.create(state).isBalanced()).toBe(true);
    expect(() => WalletLedgerEntry.create({ ...state, balanceAfter: brl('90') })).toThrow('INVALID_LEDGER_ENTRY');
    expect(() => WalletLedgerEntry.create({ ...state, money: brl('0'), balanceAfter: brl('100') }))
      .toThrow('INVALID_LEDGER_ENTRY');
  });
});

test('directions for BET/WIN/LOSS/REFUND/ROLLBACK and scope/amount/status validation', () => {
  const bet = processed({});
  const win = processed({ kind: 'WIN', externalTransactionId: 'win' });
  const refund = processed({ kind: 'REFUND', externalTransactionId: 'refund', referenceExternalTransactionId: 'bet' });
  const loss = wager({ kind: 'LOSS' });
  expect(bet.ledgerDirectionFor()).toBe('DEBIT');
  expect(win.ledgerDirectionFor()).toBe('CREDIT');
  expect(loss.affectsBalance()).toBe(false);
  expect(bet.affectsBalance()).toBe(true);
  expect(() => loss.ledgerDirectionFor()).toThrow();
  expect(refund.requiresReference()).toBe(true);
  expect(win.requiresReference()).toBe(false);
  expect(refund.ledgerDirectionFor(bet)).toBe('CREDIT');
  for (const [target, direction] of [[bet, 'CREDIT'], [win, 'DEBIT'], [refund, 'DEBIT']] as const) {
    const rollback = wager({ kind: 'ROLLBACK', externalTransactionId: 'rb',
      referenceExternalTransactionId: target.externalTransactionId });
    rollback.assertReference(target);
    expect(rollback.ledgerDirectionFor(target)).toBe(direction);
  }
  const reversal = wager({ kind: 'REFUND', externalTransactionId: 'refund', referenceExternalTransactionId: 'bet' });
  expect(() => reversal.assertReference()).toThrow('REFERENCE_NOT_PROCESSED');
  expect(() => reversal.assertReference(wager({}))).toThrow('REFERENCE_NOT_PROCESSED');
  for (const changes of [{ roundId: 'other' }, { providerId: 'other' }, { walletId: randomUUID() },
    { playerId: randomUUID() }, { money: Money.from({ amount: '8', currency: 'USD' }) }]) {
    expect(() => reversal.assertReference(processed(changes))).toThrow('REFERENCE_SCOPE_MISMATCH');
  }
  expect(() => reversal.assertReference(processed({ money: brl('8.01') }))).toThrow('REFERENCE_AMOUNT_MISMATCH');
  expect(() => reversal.assertReference(win)).toThrow('INVALID_REFERENCE_KIND');
  expect(() => reversal.assertReference(win)).toThrow(BusinessRuleViolation);
  const prize = wager({ kind: 'WIN', money: brl('12'), externalTransactionId: 'win', referenceExternalTransactionId: 'bet' });
  prize.assertReference(bet);
  expect(prize.ledgerDirectionFor(bet)).toBe('CREDIT');
  expect(() => wager({ kind: 'REFUND', externalTransactionId: 'r' })).toThrow('REFERENCE_REQUIRED');
  expect(() => wager({ kind: 'LOSS', referenceExternalTransactionId: 'bet' })).toThrow('REFERENCE_NOT_ALLOWED');
  expect(() => wager({ kind: 'ROLLBACK', referenceExternalTransactionId: 'bet' })).toThrow('SELF_REFERENCE');
});

test('transitions permit a pending reference to complete and forbid all terminal mutations', () => {
  for (const finish of [(tx: WagerTransaction) => tx.markProcessed(undefined, at),
    (tx: WagerTransaction) => tx.reject(FailureCode.InsufficientFunds),
    (tx: WagerTransaction) => tx.fail(FailureCode.PermanentPersistenceError)]) {
    const tx = wager({});
    expect(tx.status).toBe('PENDING');
    tx.markPendingReference();
    tx.markPendingReference();
    expect(tx.isTerminal()).toBe(false);
    finish(tx);
    expect(tx.isTerminal()).toBe(true);
    for (const mutate of [finish, (t: WagerTransaction) => t.markPendingReference()]) {
      expect(() => mutate(tx)).toThrow(InvalidTransactionStateError);
    }
  }
  const done = processed({});
  expect(done.processedAt).toEqual(at);
  const copy = WagerTransaction.rehydrate(done.toState());
  expect(copy.status).toBe('PROCESSED');
  expect(() => copy.reject(FailureCode.AlreadyReversed)).toThrow(InvalidTransactionStateError);
});

test('canonical business hash normalizes Money and detects divergent payload under one key', () => {
  const input = wagerFrom({ ...template, money: { amount: '08.0', currency: 'BRL' } });
  expect(wagerHash(input)).toBe(wagerHash(template));
  const original = wager({});
  expect(original.matchesPayload(wagerHash(template))).toBe(true);
  expect(original.matchesPayload(wagerHash({ ...template, money: brl('8.01') }))).toBe(false);
  expect(() => wagerFrom({ ...template, kind: 'OPENING', money: brl('8').toJSON() })).toThrow('INVALID_KIND');
});

test('integration events carry type and version on the class and MoneyProps in data', () => {
  const wallet = Wallet.open({ id: template.walletId, playerId: template.playerId, initialBalance: brl('100'), at });
  const bet = wager({});
  const entry = wallet.debit({ ...movement('8'), transactionId: bet.id })!;
  bet.markProcessed(undefined, at);
  const changed = WalletBalanceChanged.from(wallet, entry, { correlationId: bet.id, causationId: 'msg-1' }).toJSON();
  expect(changed).toMatchObject({ eventType: 'WalletBalanceChanged', version: 1, aggregateId: wallet.id,
    correlationId: bet.id, causationId: 'msg-1', data: { direction: 'DEBIT', walletVersion: 2,
      money: { amount: '8.00', currency: 'BRL' }, balanceAfter: { amount: '92.00', currency: 'BRL' } } });
  expect(typeof changed.occurredAt).toBe('string');
  const event = WagerTransactionProcessed.from(bet, wallet.balance, { correlationId: bet.id });
  expect(event.toJSON()).toMatchObject({ eventType: 'WagerTransactionProcessed', aggregateId: bet.id,
    data: { status: 'PROCESSED', balance: { amount: '92.00', currency: 'BRL' } } });
  expect(event.toJSON()).not.toHaveProperty('causationId');
  expect(() => WagerTransactionRejected.from(bet, wallet.balance, { correlationId: bet.id })).toThrow();
  expect(JSON.parse(JSON.stringify(event))).toEqual(event.toJSON());
});

test('outbox schedules retries with backoff and inbox records processing once', () => {
  const wallet = Wallet.open({ id: randomUUID(), playerId: randomUUID(), initialBalance: brl('10'), at });
  const entry = wallet.debit(movement('1'))!;
  const event = WalletBalanceChanged.from(wallet, entry, { correlationId: 'c' });
  const message = OutboxMessage.enqueue(event);
  expect(message.id).toBe(event.eventId);
  expect(message.isPending()).toBe(true);
  expect(message.isDue(event.occurredAt)).toBe(true);
  const now = new Date(at.getTime() + 60_000);
  message.scheduleRetry(now);
  expect(message.attempts).toBe(1);
  expect(message.nextAttemptAt).toEqual(new Date(now.getTime() + 1000));
  expect(message.isDue(now)).toBe(false);
  message.scheduleRetry(now);
  expect(message.nextAttemptAt).toEqual(new Date(now.getTime() + 2000));
  const late = OutboxMessage.rehydrate({ id: 'x', aggregateId: 'a', eventType: 't', payload: {}, occurredAt: at,
    attempts: 20 });
  late.scheduleRetry(now);
  expect(late.nextAttemptAt).toEqual(new Date(now.getTime() + 256_000));
  message.markPublished(now);
  expect(message.isPending()).toBe(false);
  expect(message.isDue(new Date(now.getTime() + 999_999))).toBe(false);
  expect(() => message.markPublished(now)).toThrow();
  expect(() => message.scheduleRetry(now)).toThrow();

  const inbox = InboxMessage.receive({ messageId: 'msg-1', consumerName: 'wagering', payloadHash: 'h' });
  expect(inbox.isProcessed()).toBe(false);
  expect(inbox.matchesPayload('h')).toBe(true);
  expect(inbox.matchesPayload('other')).toBe(false);
  inbox.markProcessed(at);
  expect(inbox.isProcessed()).toBe(true);
  expect(() => inbox.markProcessed(at)).toThrow();
});
