import { EntitySchema } from '@mikro-orm/core';
import { Migration, Migrator } from '@mikro-orm/migrations';
import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import { migrationSql } from './schema';

const WalletRow = new EntitySchema({
  name: 'WalletRow', tableName: 'wallet',
  properties: {
    id: { type: 'uuid', primary: true },
    player_id: { type: 'uuid' },
    currency: { type: 'string' },
    balance: { type: 'decimal', runtimeType: 'string', columnType: 'numeric' },
    version: { type: 'integer' },
  },
});

class Migration20261123000000 extends Migration {
  up(): void { this.addSql(migrationSql); }
  down(): void {
    this.addSql('drop table outbox, inbox, ledger, wager, wallet; drop function protect_ledger(); drop domain money_amount;');
  }
}

class Migration20261123000001 extends Migration {
  up(): void {
    this.addSql(`
      create function validate_ledger_wager() returns trigger language plpgsql as $$
      begin
        if not exists (
          select 1 from wager t left join wager reference on reference.id = t.reference_id
          where t.id = new.transaction_id and t.wallet_id = new.wallet_id
            and t.status = 'PROCESSED' and t.kind <> 'LOSS'
            and t.currency = new.currency and t.amount = new.amount
            and t.observed_balance = new.balance_after
            and new.direction = case
              when t.kind = 'BET' then 'DEBIT'
              when t.kind in ('OPENING', 'WIN', 'REFUND') then 'CREDIT'
              when t.kind = 'ROLLBACK' and reference.kind = 'BET' then 'CREDIT'
              when t.kind = 'ROLLBACK' and reference.kind in ('WIN', 'REFUND') then 'DEBIT'
            end
        ) then
          raise exception 'ledger entry does not match a processed financial wager' using errcode = '23514';
        end if;
        return new;
      end
      $$;
      create trigger ledger_validate_wager before insert on ledger
        for each row execute function validate_ledger_wager();
    `);
  }

  down(): void {
    this.addSql('drop trigger ledger_validate_wager on ledger; drop function validate_ledger_wager();');
  }
}

// A referenced transaction may be reversed at most once, whatever the reversal kind.
// Per-kind uniqueness allowed REFUND and ROLLBACK of the same BET, crediting it twice.
class Migration20261123000002 extends Migration {
  up(): void {
    this.addSql(`
      drop index wager_single_reversal;
      create unique index wager_single_reversal on wager(reference_id)
        where status = 'PROCESSED' and kind in ('REFUND','ROLLBACK');
    `);
  }

  down(): void {
    this.addSql(`
      drop index wager_single_reversal;
      create unique index wager_single_reversal on wager(reference_id, kind)
        where status = 'PROCESSED' and kind in ('REFUND','ROLLBACK');
    `);
  }
}

// A transaction from another player or in another currency is persisted as REJECTED for auditing, so the
// composite FK to wallet(id, player_id, currency) gives way to a FK on the wallet plus a scope trigger that
// still binds every PENDING_REFERENCE or PROCESSED row to its wallet's player and currency.
class Migration20261123000003 extends Migration {
  up(): void {
    this.addSql(`
      alter table wager drop constraint wager_wallet_id_player_id_currency_fkey;
      alter table wager add constraint wager_wallet_fkey foreign key (wallet_id) references wallet(id);
      alter table wager add constraint wager_currency_format check (currency ~ '^[A-Z]{3}$');
      create function validate_wager_scope() returns trigger language plpgsql as $$
      begin
        if new.status in ('PENDING_REFERENCE', 'PROCESSED') and not exists (
          select 1 from wallet w
          where w.id = new.wallet_id and w.player_id = new.player_id and w.currency = new.currency
        ) then
          raise exception 'wager scope does not match its wallet' using errcode = '23514';
        end if;
        return new;
      end
      $$;
      create trigger wager_validate_scope before insert or update on wager
        for each row execute function validate_wager_scope();
    `);
  }

  // NOT VALID keeps audited REJECTED rows with a mismatched player or currency, and enforces the FK for new rows.
  down(): void {
    this.addSql(`
      drop trigger wager_validate_scope on wager;
      drop function validate_wager_scope();
      alter table wager drop constraint wager_currency_format;
      alter table wager drop constraint wager_wallet_fkey;
      alter table wager add constraint wager_wallet_id_player_id_currency_fkey
        foreign key (wallet_id, player_id, currency) references wallet(id, player_id, currency) not valid;
    `);
  }
}

export function connect() {
  return MikroORM.init({
    clientUrl: process.env.DATABASE_URL || 'postgresql://wager:wager@localhost:5432/wager',
    entities: [WalletRow],
    extensions: [Migrator],
    migrations: { migrationsList: [
      { name: 'Migration20261123000000', class: Migration20261123000000 },
      { name: 'Migration20261123000001', class: Migration20261123000001 },
      { name: 'Migration20261123000002', class: Migration20261123000002 },
      { name: 'Migration20261123000003', class: Migration20261123000003 },
    ] },
    driverOptions: { connection: { statement_timeout: 12000, lock_timeout: 5000 } },
  });
}
export type Database = Awaited<ReturnType<typeof connect>>;

export async function query<T extends object>(em: EntityManager, sql: string, params: readonly unknown[] = []): Promise<T[]> {
  return em.getConnection().execute<T[]>(sql, [...params], 'all', em.getTransactionContext());
}

if (require.main === module) {
  void (async () => {
    const mode = process.argv[2];
    if (mode !== 'up' && mode !== 'down') throw new Error('Expected migration direction up or down');
    const db = await connect();
    try { await db.getMigrator()[mode](); } finally { await db.close(); }
  })().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
