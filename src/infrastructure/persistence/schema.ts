export const migrationSql = `
create domain money_amount as numeric
  check (value between 0 and 9999999999999999.99 and scale(value) <= 2);

create table wallet (
  id uuid primary key,
  player_id uuid not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  balance money_amount not null,
  version integer not null check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (player_id, currency),
  unique (id, player_id, currency),
  unique (id, currency)
);

create table wager (
  id uuid primary key,
  provider_id text not null,
  external_id text not null,
  idempotency_key text not null,
  payload_hash text not null,
  wallet_id uuid not null,
  player_id uuid not null,
  round_id text not null,
  game_id text not null,
  kind text not null check (kind in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
  amount money_amount not null,
  currency text not null,
  reference_external_id text,
  reference_id uuid,
  status text not null check (status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
  failure_code text,
  observed_balance money_amount,
  attempts integer not null default 0,
  next_attempt_at timestamptz,
  causation_id text,
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (provider_id, external_id),
  unique (provider_id, idempotency_key),
  unique (wallet_id, id),
  foreign key (wallet_id, player_id, currency) references wallet(id, player_id, currency),
  foreign key (wallet_id, reference_id) references wager(wallet_id, id),
  check ((status in ('REJECTED','FAILED')) = (failure_code is not null)),
  check ((status = 'PROCESSED') = (processed_at is not null)),
  check ((status = 'PENDING_REFERENCE') = (next_attempt_at is not null))
);
create unique index wager_single_reversal on wager(reference_id, kind)
  where status = 'PROCESSED' and kind in ('REFUND','ROLLBACK');
create index wager_due on wager(next_attempt_at, id) where status = 'PENDING_REFERENCE';

create table ledger (
  sequence bigint generated always as identity primary key,
  id uuid not null unique,
  wallet_id uuid not null,
  transaction_id uuid not null,
  direction text not null check (direction in ('DEBIT','CREDIT')),
  amount money_amount not null check (amount > 0),
  currency text not null,
  balance_before money_amount not null,
  balance_after money_amount not null,
  created_at timestamptz not null default now(),
  unique (wallet_id, transaction_id),
  foreign key (wallet_id, currency) references wallet(id, currency),
  foreign key (wallet_id, transaction_id) references wager(wallet_id, id),
  check (balance_after = balance_before + case direction when 'CREDIT' then amount else -amount end)
);
create index ledger_page on ledger(wallet_id, sequence);
create function protect_ledger() returns trigger language plpgsql as $$
begin
  raise exception 'ledger is append-only' using errcode = '55000';
end
$$;
create trigger ledger_append_only before update or delete or truncate on ledger
  for each statement execute function protect_ledger();

create table inbox (
  consumer_name text not null,
  message_id text not null,
  payload_hash text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  primary key (consumer_name, message_id)
);

create table outbox (
  id uuid primary key,
  aggregate_id uuid not null,
  event_type text not null,
  payload jsonb not null,
  occurred_at timestamptz not null,
  next_attempt_at timestamptz not null default now(),
  attempts integer not null default 0,
  published_at timestamptz
);
create index outbox_due on outbox(next_attempt_at, id) where published_at is null;
`;
