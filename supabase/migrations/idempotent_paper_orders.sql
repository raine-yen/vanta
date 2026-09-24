-- Release hardening: make mobile paper-order retries idempotent.
-- Apply this in Supabase SQL Editor before shipping the mobile build.
alter table if exists orders add column if not exists client_order_id text;

create unique index if not exists idx_orders_account_client_order
  on orders(account_id, client_order_id)
  where client_order_id is not null;
