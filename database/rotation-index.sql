-- Rotation Index — the rotation rule tracked forward on paper, one row per day.
-- Written by the backend (service role) only; row security on with no policies,
-- so no client can read or write it directly.
create table if not exists public.rotation_index_days (
  index_id   text        not null,
  date       date        not null,
  nav        numeric     not null, -- the index, 100 at the start
  btc        numeric     not null, -- holding BTC instead
  top10      numeric     not null, -- top-10 by market cap instead
  state      jsonb       not null, -- cash, holdings, pending orders
  trades     jsonb,                -- fills made this day
  review     jsonb,                -- the review decided this day
  created_at timestamptz not null default now(),
  primary key (index_id, date)
);
alter table public.rotation_index_days enable row level security;
