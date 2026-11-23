import { randomUUID } from 'node:crypto';
import type { FailureCode } from './failure-codes';
import type { LedgerDirection, WalletLedgerEntry } from './ledger-entry';
import type { Money, MoneyProps } from './money';
import type { Wallet } from './wallet';
import { WagerTransactionStatus, type WagerTransaction, type WagerTransactionKind } from './wager-transaction';

export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

/** Tracing data supplied by the use case. `eventId` and `occurredAt` default to a new UUID and now. */
export interface EventContext {
  correlationId: string;
  causationId?: string;
  eventId?: string;
  occurredAt?: Date;
}

/** Serialized envelope stored in the outbox payload and published as-is. */
export interface IntegrationEventEnvelope<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: T;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = Object.freeze({ ...props.data });
  }

  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId ? { causationId: this.causationId } : {}),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data as T,
    };
  }
}

function props<T>(aggregateId: string, context: EventContext, data: T): IntegrationEventProps<T> {
  return { eventId: context.eventId ?? randomUUID(), aggregateId, correlationId: context.correlationId,
    causationId: context.causationId, occurredAt: context.occurredAt ?? new Date(), data };
}

/** Data shared by the transaction lifecycle events. Amounts are MoneyProps, never Money instances. */
export interface WagerTransactionEventData {
  transactionId: string;
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
  money: MoneyProps;
  balance: MoneyProps;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
}

function wagerData(transaction: WagerTransaction, balance: Money): WagerTransactionEventData {
  return {
    transactionId: transaction.id,
    walletId: transaction.walletId,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    kind: transaction.kind,
    status: transaction.status,
    money: transaction.money.toJSON(),
    balance: balance.toJSON(),
    ...(transaction.referenceTransactionId ? { referenceTransactionId: transaction.referenceTransactionId } : {}),
    ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}),
  };
}

function assertStatus(transaction: WagerTransaction, expected: WagerTransactionStatus, eventType: string): void {
  if (transaction.status !== expected) {
    throw new Error(`${eventType} requires status ${expected}, got ${transaction.status}`);
  }
}

/** Any applied transaction, including LOSS. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  private constructor(eventProps: IntegrationEventProps<WagerTransactionEventData>) { super(eventProps); }

  static from(transaction: WagerTransaction, balance: Money, context: EventContext): WagerTransactionProcessed {
    assertStatus(transaction, WagerTransactionStatus.Processed, 'WagerTransactionProcessed');
    return new WagerTransactionProcessed(props(transaction.id, context, wagerData(transaction, balance)));
  }
}

/** A transaction rejected by a business rule. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  private constructor(eventProps: IntegrationEventProps<WagerTransactionEventData>) { super(eventProps); }

  static from(transaction: WagerTransaction, balance: Money, context: EventContext): WagerTransactionRejected {
    assertStatus(transaction, WagerTransactionStatus.Rejected, 'WagerTransactionRejected');
    return new WagerTransactionRejected(props(transaction.id, context, wagerData(transaction, balance)));
  }
}

/** A transaction waiting for the transaction it references. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  private constructor(eventProps: IntegrationEventProps<WagerTransactionEventData>) { super(eventProps); }

  static from(transaction: WagerTransaction, balance: Money, context: EventContext): WagerTransactionPendingReference {
    assertStatus(transaction, WagerTransactionStatus.PendingReference, 'WagerTransactionPendingReference');
    return new WagerTransactionPendingReference(props(transaction.id, context, wagerData(transaction, balance)));
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** Emitted only when the balance changes, together with its ledger entry. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  private constructor(eventProps: IntegrationEventProps<WalletBalanceChangedData>) { super(eventProps); }

  static from(wallet: Wallet, entry: WalletLedgerEntry, context: EventContext): WalletBalanceChanged {
    if (entry.walletId !== wallet.id) throw new Error('Ledger entry belongs to another wallet');
    return new WalletBalanceChanged(props(wallet.id, context, {
      walletId: wallet.id,
      transactionId: entry.transactionId,
      direction: entry.direction,
      money: entry.money.toJSON(),
      balanceBefore: entry.balanceBefore.toJSON(),
      balanceAfter: entry.balanceAfter.toJSON(),
      walletVersion: wallet.version,
    }));
  }
}
