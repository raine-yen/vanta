-- Bring older installations into line with the order engine used by the web
-- ticket. This is idempotent and must be applied before deploying the code.

alter table if exists orders add column if not exists type text;
alter table if exists orders add column if not exists limit_price numeric;
alter table if exists orders add column if not exists reject_reason text;
alter table if exists orders add column if not exists filled_at timestamptz;
alter table if exists orders add column if not exists canceled_at timestamptz;
alter table if exists orders add column if not exists scheduled_at timestamptz;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders' and column_name = 'order_type'
  ) then
    execute 'update orders set type = coalesce(type, order_type) where type is null';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders' and column_name = 'price_limit'
  ) then
    execute 'update orders set limit_price = coalesce(limit_price, price_limit) where limit_price is null';
  end if;
end
$$;

update orders set type = 'market' where type is null;
alter table if exists orders alter column type set default 'market';
alter table if exists orders alter column type set not null;

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

alter table if exists prices add column if not exists prev_close numeric;
alter table if exists prices add column if not exists updated_at timestamptz;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'prices' and column_name = 'captured_at'
  ) then
    execute 'update prices set updated_at = coalesce(updated_at, captured_at) where updated_at is null';
  end if;
end
$$;

update prices set updated_at = now() where updated_at is null;
alter table if exists prices alter column updated_at set default now();
alter table if exists prices alter column updated_at set not null;
