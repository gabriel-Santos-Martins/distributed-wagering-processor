import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { wagerFrom, wagerHash } from '../src/contracts';
import { DomainError, idempotencyMatch, Money, Wallet, WalletLedgerEntry, WagerTransaction, type WagerInput } from '../src/domain';

const brl = (amount: string, allowNegative = false) => Money.from({ amount, currency: 'BRL' }, allowNegative);
const template: WagerInput = { providerId: 'provider', externalTransactionId: 'bet', gameId: 'game', roundId: 'round',
  walletId: randomUUID(), playerId: randomUUID(), kind: 'BET', money: brl('8') };

function wager(overrides: Partial<WagerInput>) {
  return WagerTransaction.create(randomUUID(), { ...template, ...overrides });
}
function processed(overrides: Partial<WagerInput>) {
  const tx = wager(overrides);
  tx.markProcessed();
  return tx;
}

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
});

test('wallet changes only after valid nonzero movements; ledger reconstructs final balance', () => {
  const initial = brl('100');
  const wallet = Wallet.open(template.walletId, template.playerId, initial);
  expect(wallet.version).toBe(1);
  expect(() => wallet.move('DEBIT', brl('100.01'), 'INSUFFICIENT_FUNDS')).toThrow('INSUFFICIENT_FUNDS');
  expect(() => wallet.move('CREDIT', Money.zero('USD'), '')).toThrow('CURRENCY_MISMATCH');
  wallet.move('CREDIT', brl('0'), '');
  expect(wallet.balance.toJSON().amount).toBe('100.00');
  expect(wallet.version).toBe(1);
  const before = wallet.move('DEBIT', brl('80'), 'INSUFFICIENT_FUNDS');
  const state = { id: randomUUID(), walletId: wallet.id, transactionId: randomUUID(), direction: 'DEBIT' as const,
    money: brl('80'), balanceBefore: before, balanceAfter: wallet.balance };
  const entry = WalletLedgerEntry.create(state);
  expect(entry.isBalanced()).toBe(true);
  expect(Object.isFrozen(entry.state)).toBe(true);
  expect(() => WalletLedgerEntry.create({ ...state, balanceAfter: brl('90') })).toThrow('INVALID_LEDGER_ENTRY');
  expect(wallet.version).toBe(2);
  expect(wallet.balance.equals(initial.subtract(entry.state.money))).toBe(true);
});

test('directions for BET/WIN/LOSS/REFUND/ROLLBACK and scope/amount/status validation', () => {
  const bet = processed({});
  const win = processed({ kind: 'WIN', externalTransactionId: 'win' });
  const refund = processed({ kind: 'REFUND', externalTransactionId: 'refund', referenceExternalTransactionId: 'bet' });
  expect(bet.direction()).toBe('DEBIT');
  expect(win.direction()).toBe('CREDIT');
  expect(wager({ kind: 'LOSS' }).direction()).toBeUndefined();
  expect(refund.direction(bet)).toBe('CREDIT');
  for (const [target, direction] of [[bet, 'CREDIT'], [win, 'DEBIT'], [refund, 'DEBIT']] as const) {
    expect(wager({ kind: 'ROLLBACK', externalTransactionId: 'rb',
      referenceExternalTransactionId: target.input.externalTransactionId }).direction(target)).toBe(direction);
  }
  const reversal = wager({ kind: 'REFUND', externalTransactionId: 'refund', referenceExternalTransactionId: 'bet' });
  expect(() => reversal.direction()).toThrow('REFERENCE_NOT_PROCESSED');
  expect(() => reversal.direction(wager({}))).toThrow('REFERENCE_NOT_PROCESSED');
  for (const changes of [{ roundId: 'other' }, { providerId: 'other' }, { walletId: randomUUID() },
    { playerId: randomUUID() }, { money: Money.from({ amount: '8', currency: 'USD' }) }]) {
    expect(() => reversal.direction(processed(changes))).toThrow('REFERENCE_SCOPE_MISMATCH');
  }
  expect(() => reversal.direction(processed({ money: brl('8.01') }))).toThrow('REFERENCE_AMOUNT_MISMATCH');
  expect(() => reversal.direction(win)).toThrow('INVALID_REFERENCE_KIND');
  expect(wager({ kind: 'WIN', money: brl('12'), externalTransactionId: 'win',
    referenceExternalTransactionId: 'bet' }).direction(bet)).toBe('CREDIT');
});

test('transitions permit a pending reference to complete and forbid all terminal mutations', () => {
  for (const finish of [(tx: WagerTransaction) => tx.markProcessed(), (tx: WagerTransaction) => tx.reject('BUSINESS'),
    (tx: WagerTransaction) => tx.fail('PERMANENT')]) {
    const tx = wager({});
    tx.markPendingReference();
    expect(tx.isTerminal).toBe(false);
    finish(tx);
    expect(tx.isTerminal).toBe(true);
    for (const mutate of [finish, (t: WagerTransaction) => t.markPendingReference()]) {
      expect(() => mutate(tx)).toThrow('TERMINAL_TRANSACTION');
    }
  }
});

test('canonical business hash normalizes Money and detects divergent payload under one key', () => {
  const input = wagerFrom({ ...template, money: { amount: '08.0', currency: 'BRL' } });
  expect(wagerHash(input)).toBe(wagerHash(template));
  expect(() => idempotencyMatch(wagerHash(template), wagerHash({ ...template, money: brl('8.01') })))
    .toThrow('IDEMPOTENCY_CONFLICT');
  expect(() => wagerFrom({ ...template, kind: 'OPENING', money: brl('8').toJSON() })).toThrow('INVALID_KIND');
});
