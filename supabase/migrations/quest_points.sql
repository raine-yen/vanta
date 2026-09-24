create table if not exists quest_points (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  quest_id text not null,
  cycle_id text not null,
  points integer not null default 200,
  claimed_at timestamptz not null default now(),
  unique(account_id, quest_id, cycle_id)
);

create index if not exists idx_quest_points_account on quest_points(account_id, cycle_id);

alter table quest_points enable row level security;

drop policy if exists "users see own quest points" on quest_points;
create policy "users see own quest points" on quest_points for select using (
  exists (select 1 from accounts a where a.id = quest_points.account_id and a.user_id = auth.uid())
);

notify pgrst, 'reload schema';
