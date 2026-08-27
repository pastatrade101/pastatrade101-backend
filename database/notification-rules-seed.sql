-- Seed the four WhatsApp rules that are worth interrupting somebody for.
--
-- The design rule behind this list: alert on a CHANGE OF STATE, never on state.
-- "BTC risk is 0.32 today" is noise a member mutes after the fourth one; "BTC
-- risk just entered the Good DCA zone, first time since March" is news. Every
-- rule below fires a handful of times a YEAR, except the weekly report.
--
-- Combined ceiling is roughly 4-6 messages a month. min_hours_between and
-- max_per_day are per-member, and WHATSAPP_MAX_PER_RUN caps any single tick.
--
-- Rules start DISABLED with a null template: nothing can send until the matching
-- template is approved in Meta and its name pasted in. Idempotent — re-running
-- refreshes labels and limits but never re-enables a rule or clobbers a
-- template name you have already set.

create table if not exists public.notification_rules (
  id                uuid primary key default gen_random_uuid(),
  key               text not null unique,
  label             text not null,
  enabled           boolean not null default false,
  plan_codes        text[] not null default '{}',
  template_name     text,
  template_language text not null default 'en',
  min_hours_between integer not null default 72,
  max_per_day       integer not null default 1,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- plan_codes '{}' = every plan, including free. These four are deliberately NOT
-- premium-gated: the alert is the hook, and the AI reading behind it is the
-- upgrade. Gating the alert itself would remove the reason to open the app.
insert into public.notification_rules (key, label, plan_codes, min_hours_between, max_per_day) values
  ('risk.band_changed',      'BTC risk band changed',        '{}', 72,  1),
  ('exit.threshold_crossed', 'Exit risk crossed a threshold','{}', 168, 1),
  ('altcoin.signal',         'Altcoin breadth regime flip',  '{}', 96,  1),
  ('report.published',       'New report published',         '{}', 24,  1),
  -- Not in the four: the escape hatch for an admin writing to members directly.
  ('manual',                 'Manual announcement',          '{}', 0,   5)
on conflict (key) do update
  set label             = excluded.label,
      min_hours_between = excluded.min_hours_between,
      max_per_day       = excluded.max_per_day,
      updated_at        = now();

-- Delivery log. `subject_id` is also the change-detector: a rule whose latest
-- send carries the same subject simply does not fire again, which is what stops
-- a value that has not moved from messaging anyone.
create table if not exists public.notification_sends (
  id           uuid primary key default gen_random_uuid(),
  batch_id     uuid,
  rule_key     text not null,
  user_id      uuid,
  subject_type text not null,
  subject_id   text not null,
  status       text not null,          -- sent | skipped | failed
  reason       text,                   -- why it was skipped/failed, in plain words
  created_at   timestamptz not null default now()
);

create index if not exists notification_sends_rule_subject
  on public.notification_sends (rule_key, subject_type, created_at desc);
create index if not exists notification_sends_user_rule
  on public.notification_sends (user_id, rule_key, created_at desc);

-- One row per dispatch, so an admin can read back what a rule actually did.
create table if not exists public.notification_batches (
  id             uuid primary key default gen_random_uuid(),
  rule_key       text not null,
  subject_type   text not null,
  subject_id     text not null,
  triggered_by   uuid,
  audience_count integer not null default 0,
  note           text,
  created_at     timestamptz not null default now()
);

create index if not exists notification_batches_rule
  on public.notification_batches (rule_key, created_at desc);

-- Opt-in lives on the member. Consent is explicit and SEPARATE from users.phone,
-- which was collected for mobile-money checkout — reusing that for broadcasts is
-- what gets a WhatsApp sender banned.
alter table public.users add column if not exists whatsapp_number         text;
alter table public.users add column if not exists whatsapp_opted_in_at    timestamptz;
alter table public.users add column if not exists whatsapp_opted_out_at   timestamptz;
alter table public.users add column if not exists whatsapp_opt_in_source  text;

create index if not exists users_whatsapp_opted_in
  on public.users (whatsapp_opted_in_at)
  where whatsapp_opted_in_at is not null;

notify pgrst, 'reload schema';
