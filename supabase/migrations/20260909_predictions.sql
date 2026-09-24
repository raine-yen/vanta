-- Prediction markets mirrored from Polymarket (read model) + paper positions.
-- Cash for prediction buys/sells/settlements is the shared accounts.cash bankroll.
create table if not exists prediction_markets (
  id text primary key,                       -- Polymarket condition id
  question text not null,
  category text,
  yes_token_id text,                         -- CLOB token id for the YES outcome
  no_token_id text,                          -- CLOB token id for the NO outcome
  yes_price numeric,                         -- 0..1 implied probability, last seen
  no_price numeric,
  volume_24h numeric,
  end_date timestamptz,
  status text not null default 'active'
    check (status in ('active','closed','resolved')),
  resolved_outcome text check (resolved_outcome in ('yes','no')),
  settled_at timestamptz,                    -- set once settlement has paid out (idempotency guard)
  image text,
  url text,
  updated_at timestamptz not null default now()
);
create index if not exists idx_pred_markets_status on prediction_markets(status, volume_24h desc);

-- One paper position per (account, market, outcome).
create table if not exists prediction_positions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  market_id text not null references prediction_markets(id) on delete cascade,
  outcome text not null check (outcome in ('yes','no')),
  shares numeric not null default 0,
  avg_cost numeric not null default 0,        -- avg price paid per share, 0..1
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(account_id, market_id, outcome)
);
create index if not exists idx_pred_pos_account on prediction_positions(account_id);

-- Immutable paper fills for predictions (parallel to ledger).
create table if not exists prediction_fills (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  market_id text not null references prediction_markets(id) on delete cascade,
  outcome text not null check (outcome in ('yes','no')),
  side text not null check (side in ('buy','sell','settle')),
  shares numeric not null,
  price numeric not null,                     -- 0..1 (settle: 1 for win, 0 for lose)
  total numeric not null,                     -- shares*price
  cash_after numeric not null,
  client_order_id text,                       -- idempotency for buy/sell (settle fills have none)
  created_at timestamptz not null default now()
);
create index if not exists idx_pred_fills_account on prediction_fills(account_id, created_at desc);
create unique index if not exists uniq_pred_fills_client_order
  on prediction_fills(account_id, client_order_id) where client_order_id is not null;

-- RLS: markets are a public read model; positions/fills are visible only to
-- their owning user. All writes go through the service-role engine only.
alter table prediction_markets enable row level security;
alter table prediction_positions enable row level security;
alter table prediction_fills enable row level security;

drop policy if exists "anyone reads markets" on prediction_markets;
create policy "anyone reads markets" on prediction_markets for select using (true);

drop policy if exists "own prediction positions" on prediction_positions;
create policy "own prediction positions" on prediction_positions for select
  using (exists (select 1 from accounts a where a.id = account_id and a.user_id = auth.uid()));

drop policy if exists "own prediction fills" on prediction_fills;
create policy "own prediction fills" on prediction_fills for select
  using (exists (select 1 from accounts a where a.id = account_id and a.user_id = auth.uid()));
