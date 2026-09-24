create or replace view public.leaderboard as
select
  a.id as account_id,
  a.competition_id,
  a.display_name,
  a.equity,
  a.starting_cash,
  case
    when coalesce(p.cost_basis, 0) > 0
      then (((a.equity - a.cash) - p.cost_basis) / p.cost_basis * 100)
    else 0
  end as return_pct,
  a.created_at,
  coalesce(p.cost_basis, 0) as cost_basis,
  ((a.equity - a.cash) - coalesce(p.cost_basis, 0)) as gain_amount
from public.accounts a
left join (
  select account_id, sum(qty * avg_entry_price) as cost_basis
  from public.positions
  group by account_id
) p on p.account_id = a.id
where a.status = 'active'
order by return_pct desc;

grant select on public.leaderboard to anon, authenticated;
