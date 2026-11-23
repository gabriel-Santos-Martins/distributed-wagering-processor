import { ChangeMessageVisibilityCommand, DeleteMessageCommand, GetQueueAttributesCommand, ReceiveMessageCommand,
  SendMessageCommand, SQSClient, type Message } from '@aws-sdk/client-sqs';
import { hash, identifier, record, wagerFrom } from '../../application/contracts';
import type { UnitOfWork } from '../../application/ports';
import type { Wagering } from '../../application/wagering';
import { DomainError, InboxMessage } from '../../domain';
import { log, observe } from '../observability';

const maxReceives = 5;
/** Inbox namespace of the wager-transactions consumer. */
export const consumerName = 'wagering';
const pause = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  if (signal.aborted) { resolve(); return; }
  const done = () => {
    clearTimeout(timer);
    signal.removeEventListener('abort', done);
    resolve();
  };
  const timer = setTimeout(done, ms);
  signal.addEventListener('abort', done, { once: true });
});

export class Queues {
  readonly endpoint = process.env.SQS_ENDPOINT || 'http://localhost:4566';
  readonly base = process.env.SQS_QUEUE_BASE || this.endpoint + '/queue/us-east-1/000000000000';
  readonly input = this.base + '/wager-transactions.fifo';
  readonly dlq = this.base + '/wager-transactions-dlq.fifo';
  readonly events = this.base + '/wager-events';
  readonly client = new SQSClient({ endpoint: this.endpoint, region: 'us-east-1', maxAttempts: 1,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });

  async ready(): Promise<void> {
    await Promise.all([this.input, this.dlq, this.events].map(QueueUrl => this.client.send(
      new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['QueueArn'] }),
      { abortSignal: AbortSignal.timeout(3000) })));
  }
}

export type WorkerHooks = {
  afterCommit?: (messageId: string | undefined) => void;
  beforePublish?: (eventId: string) => void;
  afterPublish?: (eventId: string) => void;
};

export class Workers {
  private readonly stop = new AbortController();
  private running: Promise<void>[] = [];
  constructor(readonly unitOfWork: UnitOfWork, readonly queues: Queues, readonly wagering: Wagering,
    private readonly hooks: WorkerHooks = {}) {}

  start(): void {
    this.running = [
      this.loop('consumer', () => this.consume()),
      this.loop('publisher', () => this.publishOne()),
      this.loop('reference', () => this.wagering.retryOne()),
    ];
  }

  async close(): Promise<void> {
    this.stop.abort();
    await Promise.all(this.running);
  }

  private async loop(worker: string, work: () => Promise<boolean>) {
    let failures = 0;
    while (!this.stop.signal.aborted) {
      try {
        if (!await work()) await pause(250, this.stop.signal);
        failures = 0;
      } catch (error) {
        if (this.stop.signal.aborted) return;
        observe(worker + '_failures_total');
        log('worker_error', { worker, errorType: error instanceof Error ? error.name : 'UnknownError' });
        await pause(Math.min(10000, 250 * 2 ** Math.min(failures++, 6)), this.stop.signal);
      }
    }
  }

  private async consume(): Promise<boolean> {
    const { Messages = [] } = await this.queues.client.send(new ReceiveMessageCommand({
      QueueUrl: this.queues.input, MaxNumberOfMessages: 1, WaitTimeSeconds: 10,
      VisibilityTimeout: 60,
      // The legacy field also supports emulators that only implement the older receive contract.
      AttributeNames: ['All'],
    }), { abortSignal: AbortSignal.timeout(15000) });
    if (Messages[0]) await this.handle(Messages[0]);
    return Messages.length > 0;
  }

  private async handle(message: Message) {
    const ReceiptHandle = message.ReceiptHandle;
    if (!ReceiptHandle) return;
    let messageId: string | undefined;
    let providerId: string | undefined;
    let walletId: string | undefined;
    const count = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    try {
      let raw: unknown;
      try { raw = JSON.parse(message.Body ?? ''); } catch { throw new DomainError('INVALID_ENVELOPE_JSON'); }
      const body = record(raw);
      messageId = identifier(body.messageId, 'INVALID_MESSAGE_ID');
      if (body.type !== 'WagerTransactionRequested' || typeof body.occurredAt !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(body.occurredAt) || !Number.isFinite(Date.parse(body.occurredAt))) {
        throw new DomainError('INVALID_ENVELOPE');
      }
      const data = record(body.data);
      const input = wagerFrom(data);
      ({ providerId, walletId } = input);
      const result = await this.wagering.submit(input, identifier(data.idempotencyKey, 'IDEMPOTENCY_KEY_REQUIRED'),
        InboxMessage.receive({ messageId, consumerName, payloadHash: hash(raw) }));
      if (result?.status === 'FAILED') throw new DomainError(result.failureCode!, 500);
    } catch (error) {
      if (error instanceof DomainError || count >= maxReceives) {
        // Send first. If either SQS operation fails, broker redelivery is still safe.
        await this.queues.client.send(new SendMessageCommand({
          QueueUrl: this.queues.dlq, MessageBody: message.Body || '{}',
          MessageGroupId: message.Attributes?.MessageGroupId || 'invalid',
          MessageDeduplicationId: message.MessageId || hash(message.Body),
          MessageAttributes: { failureCode: { DataType: 'String',
            StringValue: error instanceof DomainError ? error.code : 'DELIVERY_EXHAUSTED' } },
        }), { abortSignal: AbortSignal.timeout(5000) });
        observe('dlq_messages_total');
        log('message_dlq', { messageId, providerId, walletId });
        await this.ack(ReceiptHandle);
      } else {
        observe('message_retries_total');
        log('message_retry', { messageId, providerId, walletId, count });
        await this.queues.client.send(new ChangeMessageVisibilityCommand({
          QueueUrl: this.queues.input, ReceiptHandle, VisibilityTimeout: this.stop.signal.aborted ? 0 : 2 ** count,
        }), { abortSignal: AbortSignal.timeout(5000) });
      }
      return;
    }
    this.hooks.afterCommit?.(messageId);
    await this.ack(ReceiptHandle);
  }

  private async ack(ReceiptHandle: string) {
    await this.queues.client.send(new DeleteMessageCommand({ QueueUrl: this.queues.input, ReceiptHandle }),
      { abortSignal: AbortSignal.timeout(5000) });
  }

  /**
   * Publishes one due outbox message. The row lock is held only while sending it, so concurrent
   * publishers split the work; a crash releases the lock and another instance resends the same eventId.
   */
  async publishOne(): Promise<boolean> {
    return this.unitOfWork.transaction(async scope => {
      const claimed = await scope.outbox.claimNextDue();
      if (!claimed) return false;
      const { message, lagSeconds } = claimed;
      observe('outbox_lag_seconds_sum', lagSeconds);
      observe('outbox_lag_seconds_count');
      try {
        this.hooks.beforePublish?.(message.id);
        await this.queues.client.send(new SendMessageCommand({
          QueueUrl: this.queues.events, MessageBody: JSON.stringify(message.payload),
        }), { abortSignal: AbortSignal.timeout(5000) });
        this.hooks.afterPublish?.(message.id);
      } catch {
        message.scheduleRetry(new Date());
        await scope.outbox.save(message);
        observe('outbox_retries_total');
        log('outbox_retry', { eventId: message.id, correlationId: message.payload.correlationId });
        return true;
      }
      message.markPublished(new Date());
      await scope.outbox.save(message);
      return true;
    });
  }
}
