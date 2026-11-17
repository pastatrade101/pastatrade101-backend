-- Rotation bot ledgers — the bot's own books for its Binance sleeve (the budget,
-- the coins it bought, its orders), one row per mode. Kept in the database so the
-- server can run the bot from the admin Rotation Index page and the command line
-- on another machine sees the same books. The trading key is never stored here:
-- it stays in the environment of the machine that runs the bot.
-- lock_owner / lock_until let only one run trade a mode at a time; a lock left by
-- a crashed run expires on its own.
-- Written by the backend (service role) only; row security on with no policies,
-- so no client can read or write it directly.
create table if not exists public.rotation_bot_ledgers (
  mode       text        primary key check (mode in ('testnet', 'live')),
  ledger     jsonb,                                -- null until the sleeve's first real run
  updated_at timestamptz not null default now(),
  lock_owner text,                                 -- the run holding the lock (host:pid)
  lock_until timestamptz                           -- when that lock expires
);
insert into public.rotation_bot_ledgers (mode) values ('testnet'), ('live') on conflict (mode) do nothing;
alter table public.rotation_bot_ledgers enable row level security;
