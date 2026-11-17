-- Rotation bot snapshots — what the owner's Binance sleeve holds, saved by the
-- rotation bot after every real run (never by a dry run) so the admin Rotation
-- Index page can show it. The bot runs on the owner's machine with the trading
-- key; only this snapshot reaches the database, never the key.
-- One row per mode per UTC day (the day's last run wins), so the rows also draw
-- the sleeve's value over time. Written by the backend (service role) only; row
-- security on with no policies, so no client can read or write it directly.
create table if not exists public.rotation_bot_snapshots (
  mode        text        not null check (mode in ('testnet', 'live')),
  date        date        not null,               -- UTC day of the run
  taken_at    timestamptz not null default now(),
  equity_usdt numeric,                            -- sleeve value (cash + coins); null before the first buy
  snapshot    jsonb       not null,               -- holdings, Spot wallet, recent trades
  primary key (mode, date)
);
alter table public.rotation_bot_snapshots enable row level security;
