import { DomainError } from './errors';
import type { Money } from './money';

export const LedgerDirection = { Debit: 'DEBIT', Credit: 'CREDIT' } as const;
export type LedgerDirection = typeof LedgerDirection[keyof typeof LedgerDirection];

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}
export type CreateLedgerEntryProps = LedgerEntryState;

/** Immutable ledger line. No mutable field and no transition method exist. */
export class WalletLedgerEntry {
  private constructor(
    readonly id: string,
    readonly walletId: string,
    readonly transactionId: string,
    readonly direction: LedgerDirection,
    readonly money: Money,
    readonly balanceBefore: Money,
    readonly balanceAfter: Money,
    readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  /** Validates the arithmetic: positive amount, non-negative balances and balanceBefore ± money = balanceAfter. */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = WalletLedgerEntry.rehydrate(props);
    if (!entry.money.isPositive() || entry.balanceBefore.isNegative() || entry.balanceAfter.isNegative() ||
        !entry.isBalanced()) {
      throw new DomainError('INVALID_LEDGER_ENTRY');
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(state.id, state.walletId, state.transactionId, state.direction, state.money,
      state.balanceBefore, state.balanceAfter, new Date(state.createdAt));
  }

  isBalanced(): boolean {
    const expected = this.direction === LedgerDirection.Debit
      ? this.balanceBefore.subtract(this.money)
      : this.balanceBefore.add(this.money);
    return expected.equals(this.balanceAfter);
  }
}
