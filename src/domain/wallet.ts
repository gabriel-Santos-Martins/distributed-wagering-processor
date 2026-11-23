import { DomainError } from './errors';
import { BusinessRuleViolation, FailureCode } from './failure-codes';
import { LedgerDirection, WalletLedgerEntry } from './ledger-entry';
import { Money } from './money';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** One balance movement. The entry id and instant come from the caller so the aggregate stays deterministic. */
export interface WalletMovement {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

/**
 * Aggregate root for a player's balance in one currency. Every balance change happens through
 * `debit`/`credit`, which return the ledger entry describing it, so balance and ledger cannot diverge.
 */
export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private _balance: Money,
    private _version: number,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /** Opens at version 1. A positive opening balance is recorded by `openingEntry`. */
  static open(props: { id: string; playerId: string; initialBalance: Money; at?: Date }): Wallet {
    if (props.initialBalance.isNegative()) throw new DomainError('INVALID_OPENING_BALANCE');
    const at = props.at ?? new Date();
    return new Wallet(props.id, props.playerId, props.initialBalance.currency, props.initialBalance, 1, at, at);
  }

  /** Rebuilds persisted state without revalidating transitions. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(state.id, state.playerId, state.currency, state.balance, state.version,
      new Date(state.createdAt), new Date(state.updatedAt));
  }

  get balance(): Money { return this._balance; }
  get version(): number { return this._version; }
  get updatedAt(): Date { return this._updatedAt; }

  /** CREDIT entry for the internal OPENING transaction; undefined when the wallet opened empty. */
  openingEntry(props: { entryId: string; transactionId: string }): WalletLedgerEntry | undefined {
    if (this._version !== 1) throw new Error('An opening entry exists only for a newly opened wallet');
    if (this._balance.isZero()) return undefined;
    return WalletLedgerEntry.create({ id: props.entryId, walletId: this.id, transactionId: props.transactionId,
      direction: LedgerDirection.Credit, money: this._balance, balanceBefore: Money.zero(this.currency),
      balanceAfter: this._balance, createdAt: this.createdAt });
  }

  /** Rejects an operation from another player or in another currency before anything is persisted. */
  assertAccepts(playerId: string, money: Money): void {
    if (playerId !== this.playerId) throw new DomainError('PLAYER_WALLET_MISMATCH');
    this.assertSameCurrency(money);
  }

  /**
   * Debits the wallet. Throws `insufficientFunds` (a BusinessRuleViolation) when the balance would turn negative.
   * A zero amount changes nothing and returns undefined.
   */
  debit(movement: WalletMovement, insufficientFunds: FailureCode = FailureCode.InsufficientFunds): WalletLedgerEntry | undefined {
    return this.move(LedgerDirection.Debit, movement, insufficientFunds);
  }

  /** Credits the wallet. A zero amount changes nothing and returns undefined. */
  credit(movement: WalletMovement): WalletLedgerEntry | undefined {
    // A credit cannot make the balance negative; overflow raises AMOUNT_LIMIT inside Money.
    return this.move(LedgerDirection.Credit, movement, FailureCode.InsufficientFunds);
  }

  toState(): WalletState {
    return { id: this.id, playerId: this.playerId, currency: this.currency, balance: this._balance,
      version: this._version, createdAt: this.createdAt, updatedAt: this._updatedAt };
  }

  toJSON() {
    return { id: this.id, playerId: this.playerId, balance: this._balance.toJSON(), version: this._version };
  }

  private move(direction: LedgerDirection, movement: WalletMovement, negativeCode: FailureCode) {
    this.assertSameCurrency(movement.money);
    if (movement.money.isNegative()) throw new DomainError('INVALID_MONEY');
    if (movement.money.isZero()) return undefined;
    const balanceBefore = this._balance;
    const balanceAfter = direction === LedgerDirection.Credit
      ? balanceBefore.add(movement.money)
      : balanceBefore.subtract(movement.money);
    if (balanceAfter.isNegative()) throw new BusinessRuleViolation(negativeCode);
    // Build the entry first: if it is invalid, the wallet stays untouched.
    const entry = WalletLedgerEntry.create({ id: movement.entryId, walletId: this.id,
      transactionId: movement.transactionId, direction, money: movement.money, balanceBefore, balanceAfter,
      createdAt: movement.at });
    this._balance = balanceAfter;
    this._version++;
    this._updatedAt = movement.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) throw new DomainError('CURRENCY_MISMATCH');
  }
}
