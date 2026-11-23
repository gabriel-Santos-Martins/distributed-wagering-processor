import { randomUUID } from 'node:crypto';
import type { Direction, MoneyDto, Status } from './domain';

type EventContext = { aggregateId: string; correlationId: string; causationId?: string };
type WagerData = {
  transactionId: string; walletId: string; providerId: string; status: Status;
  money: MoneyDto; balance: MoneyDto; failureCode?: string;
};
type BalanceData = {
  walletId: string; transactionId: string; direction: Direction; money: MoneyDto;
  balanceBefore: MoneyDto; balanceAfter: MoneyDto; walletVersion: number;
};

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  readonly version = 1;
  readonly eventId = randomUUID();
  readonly occurredAt = new Date().toISOString();
  constructor(readonly context: Readonly<EventContext>, readonly data: Readonly<T>) {}
  toJSON() {
    return { eventId: this.eventId, eventType: this.eventType, ...this.context,
      occurredAt: this.occurredAt, version: this.version, data: this.data };
  }
}
export class WagerTransactionProcessed extends IntegrationEvent<WagerData> {
  readonly eventType = 'WagerTransactionProcessed';
}
export class WagerTransactionRejected extends IntegrationEvent<WagerData> {
  readonly eventType = 'WagerTransactionRejected';
}
export class WagerTransactionPendingReference extends IntegrationEvent<WagerData> {
  readonly eventType = 'WagerTransactionPendingReference';
}
export class WalletBalanceChanged extends IntegrationEvent<BalanceData> {
  readonly eventType = 'WalletBalanceChanged';
}

export class OutboxMessage {
  private constructor(readonly payload: ReturnType<IntegrationEvent<unknown>['toJSON']>) {}
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage { return OutboxMessage.rehydrate(event.toJSON()); }
  static rehydrate(payload: OutboxMessage['payload']): OutboxMessage {
    return new OutboxMessage(Object.freeze({ ...payload }));
  }
}

export class InboxMessage {
  private constructor(readonly messageId: string, readonly consumerName: string, readonly payloadHash: string,
    private completedAt?: string) {}
  static receive(messageId: string, payloadHash: string): InboxMessage {
    return InboxMessage.rehydrate(messageId, 'wagering', payloadHash);
  }
  static rehydrate(messageId: string, consumerName: string, payloadHash: string, processedAt?: string): InboxMessage {
    return new InboxMessage(messageId, consumerName, payloadHash, processedAt);
  }
  get processedAt() { return this.completedAt; }
  markProcessed(): void { this.completedAt = new Date().toISOString(); }
}
