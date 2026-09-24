-- Rank history: persists per-account rank snapshots so rank up/down movement
-- survives across recomputations (leaderboard GET triggers the recompute).
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
