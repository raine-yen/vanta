-- PaperAI Trader website chat: deploy the social tables that were present in
-- schema.sql but missing from the connected production database.

create table if not exists public.blocked_users (
  id uuid primary key default gen_random_uuid(),
  blocker_account_id uuid not null references public.accounts(id) on delete cascade,
  blocked_account_id uuid not null references public.accounts(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique(blocker_account_id, blocked_account_id),
  check (blocker_account_id <> blocked_account_id)
);

create index if not exists idx_blocked_users_blocker on public.blocked_users(blocker_account_id);
create index if not exists idx_blocked_users_blocked on public.blocked_users(blocked_account_id);

create table if not exists public.direct_messages (
  id uuid primary key default gen_random_uuid(),
  sender_account_id uuid not null references public.accounts(id) on delete cascade,
  recipient_account_id uuid not null references public.accounts(id) on delete cascade,
  body text not null check (char_length(trim(body)) between 1 and 500),
  hidden_by_admin boolean not null default false,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  check (sender_account_id <> recipient_account_id)
);

create index if not exists idx_direct_messages_sender on public.direct_messages(sender_account_id, created_at desc);
create index if not exists idx_direct_messages_recipient on public.direct_messages(recipient_account_id, created_at desc);

create table if not exists public.message_reports (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.direct_messages(id) on delete cascade,
  reporter_account_id uuid not null references public.accounts(id) on delete cascade,
  reason text not null check (char_length(trim(reason)) between 1 and 500),
  status text not null default 'open' check (status in ('open','reviewed','dismissed')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  unique(message_id, reporter_account_id)
);

create index if not exists idx_message_reports_status on public.message_reports(status, created_at desc);

alter table public.blocked_users enable row level security;
alter table public.direct_messages enable row level security;
alter table public.message_reports enable row level security;

drop policy if exists "users manage own blocks" on public.blocked_users;
create policy "users manage own blocks" on public.blocked_users for all
using (exists (select 1 from public.accounts a where a.id = blocker_account_id and a.user_id = auth.uid()))
with check (exists (select 1 from public.accounts a where a.id = blocker_account_id and a.user_id = auth.uid()));

drop policy if exists "users see own direct messages" on public.direct_messages;
create policy "users see own direct messages" on public.direct_messages for select
using (exists (
  select 1 from public.accounts a
  where a.id in (sender_account_id, recipient_account_id) and a.user_id = auth.uid()
));

drop policy if exists "users send own direct messages" on public.direct_messages;
create policy "users send own direct messages" on public.direct_messages for insert
with check (
  exists (select 1 from public.accounts sender where sender.id = sender_account_id and sender.user_id = auth.uid())
  and exists (
    select 1
    from public.accounts sender
    join public.accounts recipient on recipient.competition_id = sender.competition_id
    where sender.id = sender_account_id and recipient.id = recipient_account_id
  )
);

drop policy if exists "users mark received direct messages read" on public.direct_messages;
create policy "users mark received direct messages read" on public.direct_messages for update
using (exists (select 1 from public.accounts a where a.id = recipient_account_id and a.user_id = auth.uid()))
with check (exists (select 1 from public.accounts a where a.id = recipient_account_id and a.user_id = auth.uid()));

drop policy if exists "users report messages" on public.message_reports;
create policy "users report messages" on public.message_reports for insert
with check (
  exists (select 1 from public.accounts a where a.id = reporter_account_id and a.user_id = auth.uid())
  and exists (
    select 1 from public.direct_messages message
    where message.id = message_id and reporter_account_id in (message.sender_account_id, message.recipient_account_id)
  )
);
