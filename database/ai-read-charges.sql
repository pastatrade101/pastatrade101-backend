-- AI "charge once per unique read" dedupe.
-- Records that a user already spent one AI-interpretation credit on a module's
-- EXACT data (facts_hash) within a month. Re-reading / refreshing the same data
-- is then free; only a data change (new hash) costs another credit.
--
-- Accessed by the backend with the service-role key, so no RLS policies needed.
-- Idempotent — safe to run more than once.

create table if not exists public.ai_read_charges (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null,
  module       text not null,
  facts_hash   text not null,
  period_start timestamptz not null,
  created_at   timestamptz not null default now(),
  unique (user_id, module, facts_hash, period_start)
);

create index if not exists ai_read_charges_lookup
  on public.ai_read_charges (user_id, module, facts_hash, period_start);

notify pgrst, 'reload schema';
