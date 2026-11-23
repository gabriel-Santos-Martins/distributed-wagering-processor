import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { createApplication } from './infrastructure/composition';
import { ApiModule, HttpErrors } from './infrastructure/http/api';
import { Queues, Workers, type WorkerHooks } from './infrastructure/messaging/sqs';
import { log } from './infrastructure/observability';
import { connect } from './infrastructure/persistence/database';

/** Composition root: database, application, HTTP API and the SQS, outbox and reference workers. */
export async function main(hooks?: WorkerHooks) {
  const db = await connect();
  const queues = new Queues();
  const { unitOfWork, wagering } = createApplication(db);
  const app = await NestFactory.create(ApiModule.register(db, queues, wagering), { logger: false });
  app.useGlobalFilters(new HttpErrors());
  const workers = new Workers(unitOfWork, queues, wagering, hooks);
  const shutdown = async () => {
    await Promise.all([app.close(), workers.close()]);
    queues.client.destroy();
    await db.close();
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => void shutdown().catch(() => { process.exitCode = 1; }));
  }
  await app.listen(Number(process.env.PORT || '3000'), process.env.HOST || '0.0.0.0');
  if (process.env.DISABLE_WORKERS !== '1') workers.start();
  log('listening');
}

if (require.main === module) void main().catch(error => {
  log('startup_error', { errorType: error instanceof Error ? error.name : 'UnknownError' });
  process.exit(1);
});
