import { DomainError } from './errors';
import { BusinessRuleViolation, FailureCode } from './failure-codes';

/** Contract representation: decimal string with two decimals and an ISO-4217 style code. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

const maxCents = 999_999_999_999_999_999n;
const amountPattern = /^-?\d{1,16}(?:\.\d{1,2})?$/;
const currencyPattern = /^[A-Z]{3}$/;

/** Immutable exact amount, stored as integer cents. Every operation returns a new instance. */
export class Money {
  private constructor(private readonly cents: bigint, readonly currency: string) {
    if (cents > maxCents || cents < -maxCents) throw new BusinessRuleViolation(FailureCode.AmountLimit);
    Object.freeze(this);
  }

  /**
   * Parses a contract amount. Rejects NaN, Infinity, scientific notation, blanks and more than two decimals.
   * Negative values are accepted only for internal differences (`allowNegative`).
   */
  static from(props: MoneyProps, allowNegative = false): Money {
    const { amount, currency } = props ?? {};
    if (typeof amount !== 'string' || typeof currency !== 'string' || !currencyPattern.test(currency) ||
        !amountPattern.test(amount) || (!allowNegative && amount.startsWith('-'))) {
      throw new DomainError('INVALID_MONEY');
    }
    const [whole, fraction = ''] = amount.replace(/^-/, '').split('.');
    const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
    return new Money(amount.startsWith('-') ? -cents : cents, currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    return this.add(other.negate());
  }

  negate(): Money {
    return new Money(-this.cents, this.currency);
  }

  isZero(): boolean { return this.cents === 0n; }
  isPositive(): boolean { return this.cents > 0n; }
  isNegative(): boolean { return this.cents < 0n; }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents === other.cents;
  }

  toJSON(): MoneyProps {
    const absolute = this.cents < 0n ? -this.cents : this.cents;
    const sign = this.cents < 0n ? '-' : '';
    return { amount: `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`, currency: this.currency };
  }

  toString(): string {
    const { amount, currency } = this.toJSON();
    return `${amount} ${currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) throw new DomainError('CURRENCY_MISMATCH');
  }
}
