-- Admin-managed paper competitions. Prize information is display-only: this
-- schema deliberately creates no payment balance, entry collection, or payout
-- execution path.

alter table public.competitions
  add column if not exists scoring_method text not null default 'return_pct',
  add column if not exists max_entrants integer,
  add column if not exists allow_crypto boolean not null default true,
  add column if not exists prize_description text,
  add column if not exists rules text,
  add column if not exists published_at timestamptz,
  add column if not exists locked_at timestamptz,
  add column if not exists settled_at timestamptz;

alter table public.competitions drop constraint if exists competitions_scoring_method_check;
alter table public.competitions add constraint competitions_scoring_method_check
  check (scoring_method in ('return_pct', 'net_profit'));

alter table public.competitions drop constraint if exists competitions_max_entrants_check;
alter table public.competitions add constraint competitions_max_entrants_check
  check (max_entrants is null or (max_entrants between 2 and 10000));

alter table public.competitions drop constraint if exists competitions_status_check;
alter table public.competitions add constraint competitions_status_check
  check (status in ('draft', 'open', 'active', 'locked', 'settled', 'ended'));

create index if not exists idx_competitions_discovery
  on public.competitions (status, start_date asc, created_at desc);

-- Competitions are readable by signed-in members. Writes only travel through
-- server-side admin routes using the service role.
alter table public.competitions enable row level security;
drop policy if exists "anyone sees competitions" on public.competitions;
drop policy if exists "authenticated users see competitions" on public.competitions;
create policy "authenticated users see competitions"
  on public.competitions for select to authenticated using (true);
