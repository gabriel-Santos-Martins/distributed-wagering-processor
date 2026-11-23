export type MoneyDto = { amount: string; currency: string };
export const maxCents = 999_999_999_999_999_999n;

export class DomainError extends Error {
  constructor(readonly code: string, readonly httpStatus = 400) { super(code); }
}

export class Money {
  private constructor(private readonly cents: bigint, readonly currency: string) {
    if (cents > maxCents || cents < -maxCents) throw new DomainError('AMOUNT_LIMIT');
    Object.freeze(this);
  }

  static from(dto: MoneyDto, allowNegative = false): Money {
    if (!dto || typeof dto.amount !== 'string' || typeof dto.currency !== 'string' ||
        !/^[A-Z]{3}$/.test(dto.currency) || dto.currency.length !== 3 ||
        !/^-?\d{1,16}(?:\.\d{1,2})?$/.test(dto.amount) || dto.amount.trim() !== dto.amount ||
        (!allowNegative && dto.amount.startsWith('-'))) {
      throw new DomainError('INVALID_MONEY');
    }
    const [whole, fraction = ''] = dto.amount.replace(/^-/, '').split('.');
    const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
    return new Money(dto.amount.startsWith('-') ? -cents : cents, dto.currency);
  }

  static zero(currency: string): Money { return Money.from({ amount: '0.00', currency }); }
  add(other: Money): Money {
    this.assertCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }
  subtract(other: Money): Money { return this.add(other.negate()); }
  negate(): Money { return new Money(-this.cents, this.currency); }
  isZero(): boolean { return this.cents === 0n; }
  isNegative(): boolean { return this.cents < 0n; }
  equals(other: Money): boolean { this.assertCurrency(other); return this.cents === other.cents; }
  assertCurrency(other: Money): void {
    if (this.currency !== other.currency) throw new DomainError('CURRENCY_MISMATCH');
  }
  toJSON(): MoneyDto {
    const absolute = this.cents < 0n ? -this.cents : this.cents;
    return {
      amount: (this.cents < 0n ? '-' : '') + String(absolute / 100n) + '.' + String(absolute % 100n).padStart(2, '0'),
      currency: this.currency,
    };
  }
}

export type WalletState = { id: string; playerId: string; balance: Money; version: number };
export type Direction = 'DEBIT' | 'CREDIT';

export class Wallet {
  private constructor(readonly id: string, readonly playerId: string, private funds: Money, private revision: number) {}
  static open(id: string, playerId: string, balance: Money): Wallet {
    if (balance.isNegative()) throw new DomainError('INVALID_OPENING_BALANCE');
    return new Wallet(id, playerId, balance, 1);
  }
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(state.id, state.playerId, state.balance, state.version);
  }
  get balance(): Money { return this.funds; }
  get version(): number { return this.revision; }
  move(direction: Direction, amount: Money, negativeCode: string): Money {
    if (amount.isNegative()) throw new DomainError('INVALID_MONEY');
    const before = this.funds;
    const after = direction === 'CREDIT' ? before.add(amount) : before.subtract(amount);
    if (after.isNegative()) throw new DomainError(negativeCode);
    if (!amount.isZero()) {
      this.funds = after;
      this.revision++;
    }
    return before;
  }
  toJSON() { return { id: this.id, playerId: this.playerId, balance: this.balance.toJSON(), version: this.version }; }
}

export const externalKinds = ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const;
export type ExternalKind = typeof externalKinds[number];
export type Kind = ExternalKind | 'OPENING';
export type Status = 'PENDING' | 'PENDING_REFERENCE' | 'PROCESSED' | 'REJECTED' | 'FAILED';
export type WagerInput = {
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: Kind;
  money: Money;
  referenceExternalTransactionId?: string;
};
type WagerState = {
  status: Status;
  failureCode?: string;
  referenceTransactionId?: string;
  processedAt?: string;
};

export function idempotencyMatch(expected: string, incoming: string): void {
  if (expected !== incoming) throw new DomainError('IDEMPOTENCY_CONFLICT', 409);
}

export class WagerTransaction {
  readonly input: Readonly<WagerInput>;
  private constructor(readonly id: string, input: WagerInput, private state: WagerState) {
    this.input = Object.freeze({ ...input });
  }
  static create(id: string, input: WagerInput): WagerTransaction {
    if (input.money.isNegative()) throw new DomainError('INVALID_MONEY');
    const reversal = input.kind === 'REFUND' || input.kind === 'ROLLBACK';
    if (reversal && !input.referenceExternalTransactionId) throw new DomainError('REFERENCE_REQUIRED');
    if (!reversal && input.kind !== 'WIN' && input.referenceExternalTransactionId) {
      throw new DomainError('REFERENCE_NOT_ALLOWED');
    }
    if (input.referenceExternalTransactionId === input.externalTransactionId) throw new DomainError('SELF_REFERENCE');
    return new WagerTransaction(id, input, { status: 'PENDING' });
  }
  static rehydrate(id: string, input: WagerInput, state: WagerState): WagerTransaction {
    return new WagerTransaction(id, input, { ...state });
  }
  get status() { return this.state.status; }
  get failureCode() { return this.state.failureCode; }
  get referenceTransactionId() { return this.state.referenceTransactionId; }
  get processedAt() { return this.state.processedAt; }
  get isTerminal(): boolean { return this.status !== 'PENDING' && this.status !== 'PENDING_REFERENCE'; }
  get isReversal(): boolean { return this.input.kind === 'REFUND' || this.input.kind === 'ROLLBACK'; }
  private transition(state: WagerState): void {
    if (this.isTerminal) throw new DomainError('TERMINAL_TRANSACTION');
    this.state = state;
  }
  markProcessed(referenceTransactionId?: string): void {
    this.transition({ status: 'PROCESSED', referenceTransactionId, processedAt: new Date().toISOString() });
  }
  markPendingReference(): void { this.transition({ status: 'PENDING_REFERENCE' }); }
  reject(failureCode: string): void { this.transition({ status: 'REJECTED', failureCode }); }
  fail(failureCode: string): void { this.transition({ status: 'FAILED', failureCode }); }

  direction(reference?: WagerTransaction): Direction | undefined {
    if (reference) {
      const current = this.input;
      const target = reference.input;
      if (current.providerId !== target.providerId || current.walletId !== target.walletId ||
          current.playerId !== target.playerId || current.roundId !== target.roundId ||
          current.money.currency !== target.money.currency) throw new DomainError('REFERENCE_SCOPE_MISMATCH');
      const kinds = current.kind === 'ROLLBACK' ? ['BET', 'WIN', 'REFUND'] : ['BET'];
      if (!kinds.includes(target.kind)) throw new DomainError('INVALID_REFERENCE_KIND');
      if (this.isReversal && !current.money.equals(target.money)) throw new DomainError('REFERENCE_AMOUNT_MISMATCH');
      if (reference.status !== 'PROCESSED') throw new DomainError('REFERENCE_NOT_PROCESSED');
    } else if (this.input.referenceExternalTransactionId) {
      throw new DomainError('REFERENCE_NOT_PROCESSED');
    }
    switch (this.input.kind) {
      case 'BET': return 'DEBIT';
      case 'WIN':
      case 'OPENING':
      case 'REFUND': return 'CREDIT';
      case 'ROLLBACK': return reference?.input.kind === 'BET' ? 'CREDIT' : 'DEBIT';
      case 'LOSS': return undefined;
    }
  }
}

export type LedgerState = {
  id: string; transactionId: string; walletId: string; direction: Direction;
  money: Money; balanceBefore: Money; balanceAfter: Money;
};

export class WalletLedgerEntry {
  private constructor(readonly state: Readonly<LedgerState>) { Object.freeze(this); }
  static create(state: LedgerState): WalletLedgerEntry {
    const entry = WalletLedgerEntry.rehydrate(state);
    if (!entry.isBalanced() || state.money.isNegative() || state.money.isZero() ||
        state.balanceBefore.isNegative() || state.balanceAfter.isNegative()) throw new DomainError('INVALID_LEDGER_ENTRY');
    return entry;
  }
  static rehydrate(state: LedgerState): WalletLedgerEntry {
    return new WalletLedgerEntry(Object.freeze({ ...state }));
  }
  isBalanced(): boolean {
    const { balanceBefore, balanceAfter, direction, money } = this.state;
    const expected = direction === 'DEBIT' ? balanceBefore.subtract(money) : balanceBefore.add(money);
    return expected.equals(balanceAfter);
  }
}
