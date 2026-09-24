-- Privileged account controls. Apply before deploying the matching admin API.
-- Suspension remains status=disabled; the expiry tells the auth/account gate when to reactivate it.
alter table accounts add column if not exists suspended_until timestamptz;

create index if not exists idx_accounts_suspended_until
  on accounts(suspended_until)
  where suspended_until is not null;
