import { Wagering } from '../application/wagering';
import { telemetry } from './observability';
import type { Database } from './persistence/database';
import { MikroOrmUnitOfWork } from './persistence/mikro-orm-unit-of-work';

/** Wires the application to its PostgreSQL adapters. */
export function createApplication(db: Database) {
  const unitOfWork = new MikroOrmUnitOfWork(db);
  return { unitOfWork, telemetry, wagering: new Wagering(unitOfWork, telemetry) };
}

export function createWagering(db: Database): Wagering {
  return createApplication(db).wagering;
}
