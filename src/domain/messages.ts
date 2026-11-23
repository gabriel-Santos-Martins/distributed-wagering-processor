import type { IntegrationEvent } from './integration-events';

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt?: Date;
}

export interface InboxMessageState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}

/** Persistent deduplication record for one consumed message, identified by (consumerName, messageId). */
export class InboxMessage {
  private constructor(
    readonly messageId: string,
    readonly consumerName: string,
    readonly payloadHash: string,
    readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, props.receivedAt ?? new Date());
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(state.messageId, state.consumerName, state.payloadHash, new Date(state.receivedAt),
      state.processedAt && new Date(state.processedAt));
  }

  get processedAt(): Date | undefined { return this._processedAt; }

  isProcessed(): boolean { return this._processedAt !== undefined; }

  /** A different hash under the same messageId is a conflict, never a duplicate. */
  matchesPayload(payloadHash: string): boolean { return this.payloadHash === payloadHash; }

  markProcessed(at: Date): void {
    if (this._processedAt) throw new Error(`Inbox message ${this.messageId} is already processed`);
    this._processedAt = at;
  }
}

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

/** Retry delay doubles per failed attempt: 1 s, 2 s, 4 s ... capped here. */
const maxRetryDelaySeconds = 256;

/** Integration event committed with the financial change and published later by a worker. */
export class OutboxMessage {
  private constructor(
    readonly id: string,
    readonly aggregateId: string,
    readonly eventType: string,
    readonly payload: Readonly<Record<string, unknown>>,
    readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  /** The outbox id is the event id, so a republished event keeps the id consumers deduplicate on. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const payload = Object.freeze({ ...event.toJSON() }) as Readonly<Record<string, unknown>>;
    return new OutboxMessage(event.eventId, event.aggregateId, event.eventType, payload, event.occurredAt, 0,
      event.occurredAt);
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(state.id, state.aggregateId, state.eventType, Object.freeze({ ...state.payload }),
      new Date(state.occurredAt), state.attempts, state.nextAttemptAt && new Date(state.nextAttemptAt),
      state.publishedAt && new Date(state.publishedAt));
  }

  get attempts(): number { return this._attempts; }
  get nextAttemptAt(): Date | undefined { return this._nextAttemptAt; }
  get publishedAt(): Date | undefined { return this._publishedAt; }

  isPending(): boolean { return this._publishedAt === undefined; }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    if (!this.isPending()) throw new Error(`Outbox message ${this.id} is already published`);
    this._publishedAt = at;
  }

  /** Counts the failed attempt and schedules the next one with exponential backoff. */
  scheduleRetry(now: Date): void {
    if (!this.isPending()) throw new Error(`Outbox message ${this.id} is already published`);
    this._attempts++;
    const delaySeconds = Math.min(2 ** (this._attempts - 1), maxRetryDelaySeconds);
    this._nextAttemptAt = new Date(now.getTime() + delaySeconds * 1000);
  }
}
