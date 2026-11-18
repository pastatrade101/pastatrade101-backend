-- Moon backtest runs — each row is one backtest of the moon-coin breakout rules
-- (buy a coin when it closes above a long sideways range on a volume surge) over
-- Binance's daily history, dead coins included. Shown on the admin Moon backtest
-- page. `summary` holds the headline numbers for the comparison table; `result`
-- holds everything (trades, equity curve, year by year).
-- Written by the backend (service role) only; row security on with no policies,
-- so no client can read or write it directly.
create table if not exists public.moon_backtests (
  id         uuid        primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name       text        not null,
  params     jsonb       not null,
  summary    jsonb       not null,
  result     jsonb       not null,
  created_by text                                   -- 'cli', or the admin who ran it
);
create index if not exists moon_backtests_created_at on public.moon_backtests (created_at desc);
alter table public.moon_backtests enable row level security;
