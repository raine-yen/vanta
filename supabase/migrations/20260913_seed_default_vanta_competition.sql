-- Keep first-time login usable while the club creates its own events. This is
-- a simulated practice portfolio, never a payment or prize account.
insert into public.competitions (
  name, description, starting_cash, start_date, status, is_default,
  scoring_method, allow_crypto, rules
)
select
  'Vanta Practice',
  'Always-on simulated trading practice for new members.',
  10000,
  now(),
  'active',
  true,
  'return_pct',
  true,
  'Practice with a $10,000 simulated portfolio. No deposits, cash-outs, or real-money trades.'
where not exists (select 1 from public.competitions where is_default = true);
