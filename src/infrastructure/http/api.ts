import { ArgumentsHost, Body, Catch, Controller, ExceptionFilter, Get, Headers, HttpException, Inject,
  Module, Param, Post, Query, Req, Res, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { identifier, moneyFrom, record, uuid, wagerFrom } from '../../application/contracts';
import { Wagering } from '../../application/wagering';
import { DomainError, InvalidTransactionStateError } from '../../domain';
import { Queues } from '../messaging/sqs';
import { log, metricSnapshot } from '../observability';
import { query, type Database } from '../persistence/database';
import { assertCanSubmitFor, AUTH_SETTINGS, AuthGuard, type AuthSettings, canActForProvider, principalOf, Public,
  Role, Roles } from './auth';

type Response = {
  status(code: number): Response;
  json(body: unknown): void;
  setHeader?(name: string, value: string): void;
};
type Request = Parameters<typeof principalOf>[0];
const statusCodes = { PROCESSED: 200, PENDING: 202, PENDING_REFERENCE: 202, REJECTED: 422, FAILED: 500 };
const DATABASE = Symbol('Database');

/**
 * Operators manage wallets and read everything. Providers submit transactions and read their own.
 * Health and metrics stay open.
 */
@Controller()
class Api {
  constructor(private readonly wagering: Wagering, private readonly queues: Queues,
    @Inject(DATABASE) private readonly db: Database) {}

  @Post('wallets')
  @Roles(Role.Operator)
  open(@Body() raw: unknown) {
    const body = record(raw);
    return this.wagering.open(uuid(body.playerId), moneyFrom(body.initialBalance));
  }

  @Get('wallets/:walletId')
  @Roles(Role.Operator)
  wallet(@Param('walletId') id: string) { return this.wagering.getWallet(uuid(id)); }

  @Get('wallets/:walletId/ledger')
  @Roles(Role.Operator)
  async ledger(@Param('walletId') id: string, @Query('limit') rawLimit: unknown, @Query('cursor') cursor: unknown) {
    const walletId = uuid(id);
    const textLimit = rawLimit ?? '50';
    if (typeof textLimit !== 'string' || !/^([1-9]\d?|100)$/.test(textLimit)) throw new DomainError('INVALID_LIMIT');
    let after = '0';
    if (cursor !== undefined) {
      if (typeof cursor !== 'string' || cursor.length > 100 || !/^[\w-]+$/.test(cursor)) {
        throw new DomainError('INVALID_CURSOR');
      }
      const decoded = Buffer.from(cursor, 'base64url').toString();
      const [scope, position, extra] = decoded.split(':');
      if (scope !== walletId || extra !== undefined || !/^\d{1,19}$/.test(position ?? '') ||
          BigInt(position) > 9223372036854775807n || Buffer.from(decoded).toString('base64url') !== cursor) {
        throw new DomainError('INVALID_CURSOR');
      }
      after = position;
    }
    const { entries, nextSequence } = await this.wagering.ledger(walletId, after, Number(textLimit));
    return { entries, nextCursor: nextSequence ? Buffer.from(walletId + ':' + nextSequence).toString('base64url') : null };
  }

  @Post('wagering/transactions')
  @Roles(Role.Provider)
  async submit(@Req() request: Request, @Body() body: unknown, @Headers('idempotency-key') key: unknown,
    @Res() response: Response) {
    const input = wagerFrom(body);
    assertCanSubmitFor(principalOf(request), input.providerId);
    const result = (await this.wagering.submit(input, identifier(key, 'IDEMPOTENCY_KEY_REQUIRED')))!;
    response.status(statusCodes[result.status]).json(result);
  }

  @Get('wagering/transactions/:transactionId')
  @Roles(Role.Operator, Role.Provider)
  async transaction(@Req() request: Request, @Param('transactionId') id: string) {
    const transaction = await this.wagering.getTransaction(uuid(id));
    // Another provider's transaction answers like a missing one, so ids cannot be probed.
    if (!canActForProvider(principalOf(request), transaction.providerId)) {
      throw new DomainError('TRANSACTION_NOT_FOUND', 404);
    }
    return transaction;
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  @Roles(Role.Operator, Role.Provider)
  externalTransaction(@Req() request: Request, @Param('providerId') provider: string,
    @Param('externalTransactionId') id: string) {
    const providerId = identifier(provider);
    if (!canActForProvider(principalOf(request), providerId)) throw new DomainError('PROVIDER_MISMATCH', 403);
    return this.wagering.getTransaction(identifier(id), providerId);
  }

  @Post('wallets/:walletId/reconciliation')
  @Roles(Role.Operator)
  async reconcile(@Param('walletId') id: string, @Res() response: Response) {
    response.status(200).json(await this.wagering.reconcile(uuid(id)));
  }

  @Public()
  @Get('health/live')
  live() { return { status: 'ok' }; }

  @Public()
  @Get('health/ready')
  async ready() {
    try {
      await Promise.all([query(this.db.em.fork(), 'select 1 from wallet limit 1'), this.queues.ready()]);
      return { status: 'ok' };
    } catch { throw new DomainError('DEPENDENCY_UNAVAILABLE', 503); }
  }

  /**
   * Counters are per process. Gauges are read from PostgreSQL and the broker at scrape time, so outbox lag
   * keeps growing even when no publisher is running.
   */
  @Public()
  @Get('metrics')
  async metrics() {
    const [database, dlq] = await Promise.allSettled([
      query<{ outbox_pending: number; outbox_oldest_pending_seconds: number; pending_references: number }>(
        this.db.em.fork(), `select
          (select count(*)::int from outbox where published_at is null) as outbox_pending,
          (select coalesce(extract(epoch from now() - min(occurred_at)), 0)::float8
             from outbox where published_at is null) as outbox_oldest_pending_seconds,
          (select count(*)::int from wager where status = 'PENDING_REFERENCE') as pending_references`),
      this.queues.dlqDepth(),
    ]);
    return {
      counters: metricSnapshot(),
      gauges: {
        ...(database.status === 'fulfilled' ? database.value[0] : { database_unavailable: 1 }),
        ...(dlq.status === 'fulfilled' ? { dlq_messages: dlq.value } : { broker_unavailable: 1 }),
      },
    };
  }
}

@Catch()
export class HttpErrors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (error instanceof DomainError) {
      if (error.httpStatus === 401) response.setHeader?.('WWW-Authenticate', 'Bearer');
      response.status(error.httpStatus).json({ error: error.code });
    } else if (error instanceof HttpException) {
      response.status(error.getStatus()).json({ error: error.getStatus() === 400 ? 'INVALID_PAYLOAD' : 'HTTP_ERROR' });
    } else if (error instanceof InvalidTransactionStateError) {
      // A programming error, not a dependency outage: retrying will not help.
      log('http_error', { errorType: error.name, transactionId: error.transactionId });
      response.status(500).json({ error: 'INTERNAL_ERROR' });
    } else {
      log('http_error', { errorType: error instanceof Error ? error.name : 'UnknownError' });
      response.status(503).json({ error: 'SERVICE_UNAVAILABLE' });
    }
  }
}

@Module({})
export class ApiModule {
  static register(db: Database, queues: Queues, wagering: Wagering, auth: AuthSettings): DynamicModule {
    return { module: ApiModule, controllers: [Api], providers: [
      { provide: Wagering, useValue: wagering },
      { provide: Queues, useValue: queues },
      { provide: DATABASE, useValue: db },
      { provide: AUTH_SETTINGS, useValue: auth },
      { provide: APP_GUARD, useClass: AuthGuard },
    ] };
  }
}
