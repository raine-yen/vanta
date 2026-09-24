-- Paper Trader: full schema
-- Run this once in Supabase SQL Editor (Project → SQL Editor → New Query → paste → Run)

-- =====================================================================
-- COMPETITIONS
-- =====================================================================

create table if not exists competitions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  starting_cash numeric not null default 10000,
  start_date timestamptz not null default now(),
  end_date timestamptz,
  status text not null default 'active' check (status in ('active','ended')),
  is_default boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Seed one default open-ended competition that everyone joins by default
insert into competitions (name, description, starting_cash, is_default, status)
select 'Club Sandbox', 'Always-on practice competition. Trade freely.', 10000, true, 'active'
where not exists (select 1 from competitions where is_default = true);

-- =====================================================================
-- ACCOUNTS — one per (user, competition)
-- =====================================================================

create table if not exists accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  competition_id uuid not null references competitions(id) on delete cascade,
  display_name text not null,
  cash numeric not null default 10000,
  starting_cash numeric not null default 10000,
  equity numeric not null default 10000,
  status text not null default 'active' check (status in ('active','disabled')),
  created_at timestamptz not null default now(),
  unique(user_id, competition_id)
);

-- =====================================================================
-- POSITIONS — per-account holdings of assets
-- =====================================================================

create table if not exists positions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  symbol text not null,
  qty numeric not null default 0,
  avg_entry_price numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_positions_account on positions(account_id);
create index if not exists idx_positions_symbol on positions(symbol);
-- Composite unique constraint: one position per account+symbol
create unique index if not exists idx_positions_account_symbol on positions(account_id, symbol);

-- =====================================================================
-- ORDERS — submitted buy/sell orders with full lifecycle tracking
-- =====================================================================

create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  client_order_id text,
  symbol text not null,
  side text not null check (side in ('buy','sell')),
  type text not null check (type in ('market','limit')) default 'market',
  qty numeric not null default 0,
  limit_price numeric, -- limit order price; null for market orders
  status text not null default 'new' check (status in ('new','filled','partially_filled','canceled','rejected','expired')),
  filled_qty numeric not null default 0,
  filled_avg_price numeric,
  reject_reason text,
  time_in_force text not null default 'gtc' check (time_in_force in ('gtc','day','ioc')),
  created_at timestamptz not null default now(),
  filled_at timestamptz,
  canceled_at timestamptz,
  scheduled_at timestamptz
);

create index if not exists idx_orders_account on orders(account_id);
create index if not exists idx_orders_status on orders(status);
create index if not exists idx_orders_symbol on orders(symbol);
create index if not exists idx_orders_scheduled on orders(scheduled_at);
-- Idempotency: one order per client_order_id per account
create unique index if not exists idx_orders_account_client_order on orders(account_id, client_order_id) where client_order_id is not null;

create table if not exists fills (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  account_id uuid not null references accounts(id) on delete cascade,
  symbol text not null,
  qty numeric not null check (qty > 0),
  price numeric not null check (price > 0),
  side text not null check (side in ('buy','sell')),
  created_at timestamptz not null default now()
);

create index if not exists idx_fills_account on fills(account_id, created_at desc);
create index if not exists idx_fills_order on fills(order_id);

-- =====================================================================
-- LEDGER — immutable fill records; every fill is a separate row
-- =====================================================================

create table if not exists ledger (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  order_id uuid references orders(id) on set null,
  symbol text not null,
  side text not null check (side in ('buy','sell')),
  qty numeric not null,
  price numeric not null,
  total numeric not null, -- qty * price
  cash_after numeric not null, -- account cash balance after this fill
  commission numeric not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_ledger_account on ledger(account_id);
create index if not exists idx_ledger_order on ledger(order_id);

-- =====================================================================
-- ASSETS — lookup table for all tradeable symbols with metadata
-- =====================================================================

create table if not exists assets (
  id uuid primary key default gen_random_uuid(),
  symbol text not null unique,
  name text not null,
  sector text,
  industry text,
  created_at timestamptz not null default now()
);

create index if not exists idx_assets_symbol on assets(symbol);

-- =====================================================================
-- QUOTES — cached price data from external feeds (updated periodically)
-- =====================================================================

create table if not exists quotes (
  id uuid primary key default gen_random_uuid(),
  symbol text not null unique,
  price numeric not null default 0,
  bid numeric not null default 0,
  ask numeric not null default 0,
  timestamp timestamptz not null default now()
);

create index if not exists idx_quotes_symbol on quotes(symbol);

-- =====================================================================
-- WATCHLISTS — user-created watchlists of symbols
-- =====================================================================

create table if not exists watchlists (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  symbol text not null,
  note text,
  created_at timestamptz not null default now(),
  unique(account_id, symbol)
);

create index if not exists idx_watchlists_account on watchlists(account_id, created_at desc);

-- =====================================================================
-- CLUBS — user groups with rank/progression systems
-- =====================================================================

create table if not exists clubs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  tier_requirements jsonb not null default '{"tiers": [{"min_points": 0, "division_min": 1, "division_max": 3}, {"min_points": 1000, "division_min": 1, "division_max": 3}, {"min_points": 2500, "division_min": 1, "division_max": 3}, {"min_points": 5000, "division_min": 1, "division_max": 3}, {"min_points": 10000, "division_min": 1, "division_max": 3}], "divisions_per_tier": 3}'::jsonb,
  is_public boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =====================================================================
-- SEASONS — competition cycles with rank resets
-- =====================================================================

create table if not exists seasons (
  id uuid primary key default gen_random_uuid(),
  club_id uuid references clubs(id) on delete set null,
  name text not null,
  description text,
  start_date timestamptz not null default now(),
  end_date timestamptz,
  status text not null default 'active' check (status in ('active','ended')),
  rank_thresholds jsonb not null default '{"min_points_for_tier_1": 2500, "min_points_for_tier_2": 5000, "min_points_for_tier_3": 10000, "min_points_for_tier_4": 25000}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =====================================================================
-- RANKS — per-account seasonal ranking within a competition/competition context
-- =====================================================================

create table if not exists ranks (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  season_id uuid references seasons(id) on delete cascade,
  tier integer not null default 1 check (tier >= 1 and tier <= 5),
  division integer not null default 1 check (division >= 1 and division <= 3),
  rank_points numeric not null default 0,
  position_in_tier integer not null default 0,
  updated_at timestamptz not null default now(),
  unique(account_id, season_id)
);

create index if not exists idx_ranks_account on ranks(account_id);
create index if not exists idx_ranks_season on ranks(season_id);

-- Rank history: per-account rank snapshots so up/down movement survives recomputation.
create table if not exists rank_history (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  season_id uuid references seasons(id) on delete cascade,
  position integer not null,
  tier integer not null default 1,
  division integer not null default 1,
  rank_points numeric not null default 0,
  recorded_at timestamptz not null default now()
);

create index if not exists idx_rank_history_account on rank_history(account_id, recorded_at desc);
create index if not exists idx_rank_history_season_position on rank_history(season_id, position);

-- =====================================================================
-- CHALLENGES — per-account challenge progress within a season
-- =====================================================================

create table if not exists challenges (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  season_id uuid references seasons(id) on delete cascade,
  title text not null,
  description text,
  target numeric not null default 0,
  current numeric not null default 0,
  status text not null default 'active' check (status in ('active','completed','failed')),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_challenges_account on challenges(account_id);
create index if not exists idx_challenges_season on challenges(season_id);

-- =====================================================================
-- ACHIEVEMENTS — per-account earned achievements/badges
-- =====================================================================

create table if not exists achievements (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  title text not null,
  description text,
  icon text,
  earned_at timestamptz not null default now()
);

create index if not exists idx_achievements_account on achievements(account_id);

-- =====================================================================
-- QUEST POINTS — optional milestone recognition (points only, never cash)
-- =====================================================================

create table if not exists quest_points (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  quest_id text not null,
  cycle_id text not null,
  points integer not null default 200 check (points >= 0),
  claimed_at timestamptz not null default now(),
  unique(account_id, quest_id, cycle_id)
);

-- The legacy claims table is retired: recognition is points-only, never cash.

-- =====================================================================
-- PRICES — historical price snapshots (for charting/P&L)
-- =====================================================================

create table if not exists prices (
  symbol text primary key,
  price numeric not null default 0,
  prev_close numeric,
  updated_at timestamptz not null default now()
);

create index if not exists idx_prices_updated_at on prices(updated_at desc);

-- =====================================================================
-- Vanta compliance: one-time $10,000 virtual cash at account creation only.
-- No transfers, no withdrawals, no deposits, no real-money pathways.
-- All cash/holdings/P&L is authoritative from the backend via Supabase.
