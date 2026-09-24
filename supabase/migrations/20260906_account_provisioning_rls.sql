-- Keep paper-account provisioning user-scoped when using the public anon key.
-- Existing financial rows cannot be updated by this policy set.
alter table public.competitions enable row level security;
alter table public.accounts enable row level security;

drop policy if exists "anyone sees competitions" on public.competitions;
create policy "anyone sees competitions"
  on public.competitions
  for select
  using (true);

drop policy if exists "users see own accounts" on public.accounts;
create policy "users see own accounts"
  on public.accounts
  for select
  using (user_id = auth.uid());

drop policy if exists "users insert own accounts" on public.accounts;
create policy "users insert own accounts"
  on public.accounts
  for insert
  with check (user_id = auth.uid());
