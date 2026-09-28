-- MAYA docs ask tally v1
--
-- The docs helper answers in the reader's browser. To see how often it
-- answers, and above all how often it has no answer, every question a reader
-- asks adds one row here: what kind of reply it got, whether the reader was
-- signed in, and where it was asked. Written by POST /api/docs-ask/tally on
-- the service role, fire and forget; read by platform admins on /admin (the
-- last 30 days) and /admin/docs-questions (the last 12 weeks).
--
-- What a row holds, and nothing else:
--   asked_on   the UTC day (not the time, so a row cannot be lined up with
--              anything else that happened that minute)
--   outcome    answered (a docs passage, confident), unsure ("This might
--              help"), canned (a set reply: a greeting, "how do I use
--              this?", a person to email...), none (no answer)
--   signed_in  whether the reader was signed in to MAYA
--   section    where it was asked: 'home' (/docs), 'support' (/support) or
--              a docs section slug ('rules', 'billing'...)
--   app_area   the MAYA screen whose Help link opened the docs in that tab
--              ('calendar', 'rules.builder'...), or '' when there was none
-- No question text, no user id, no email, no IP address, no property.
--
-- docs_ask_tally_counts(since) and docs_ask_tally_weekly(since) add the rows
-- up for the admin pages. They run as the caller, so row level security
-- applies: a platform admin gets the counts, anyone else gets nothing.
--
-- Run AFTER 02_supabase_schema.sql (needs public.is_platform_admin).
-- Idempotent: safe to run twice.

begin;

create table if not exists public.docs_ask_tally (
  id         bigint generated always as identity primary key,
  asked_on   date not null default ((now() at time zone 'utc')::date),
  outcome    text not null,
  signed_in  boolean not null default false,
  section    text not null default '',
  app_area   text not null default '',
  constraint docs_ask_tally_outcome check (outcome in ('answered', 'unsure', 'canned', 'none')),
  constraint docs_ask_tally_section_shape check (section ~ '^[a-z0-9-]{0,40}$'),
  constraint docs_ask_tally_app_area_shape check (app_area ~ '^[a-z0-9.-]{0,40}$')
);

create index if not exists idx_docs_ask_tally_asked_on
  on public.docs_ask_tally (asked_on desc);

comment on table public.docs_ask_tally is
  'One row per question asked in the docs helper: the day, the kind of reply (answered, unsure, canned, none), '
  'whether the reader was signed in, and the docs section or MAYA screen it was asked from. No question text, '
  'no user id, no IP, no property. Written only by POST /api/docs-ask/tally on the service role; read by platform admins.';

alter table public.docs_ask_tally enable row level security;

-- Nobody but the service role writes; platform admins read.
revoke all on public.docs_ask_tally from public, anon, authenticated;
grant select on public.docs_ask_tally to authenticated;
grant select, insert on public.docs_ask_tally to service_role;

drop policy if exists docs_ask_tally_platform_read on public.docs_ask_tally;
create policy docs_ask_tally_platform_read
  on public.docs_ask_tally for select
  using (public.is_platform_admin());

-- Replies by kind since a day, for the Command Center tile.
create or replace function public.docs_ask_tally_counts(p_since date)
returns table (outcome text, n bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select t.outcome, count(*)::bigint
  from public.docs_ask_tally t
  where t.asked_on >= p_since
  group by t.outcome
$$;

-- Weekly counts since a day (weeks start on Monday), for /admin/docs-questions:
-- by kind of reply and signed in or not, by kind and docs section, and by
-- kind and MAYA screen. The columns a row is not grouped by are null.
create or replace function public.docs_ask_tally_weekly(p_since date)
returns table (week date, outcome text, signed_in boolean, section text, app_area text, n bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select w.week, w.outcome, w.signed_in, w.section, w.app_area, count(*)::bigint
  from (
    select date_trunc('week', t.asked_on::timestamp)::date as week, t.outcome, t.signed_in, t.section, t.app_area
    from public.docs_ask_tally t
    where t.asked_on >= p_since
  ) w
  group by grouping sets (
    (w.week, w.outcome, w.signed_in),
    (w.week, w.outcome, w.section),
    (w.week, w.outcome, w.app_area)
  )
$$;

revoke all on function public.docs_ask_tally_counts(date) from public, anon;
revoke all on function public.docs_ask_tally_weekly(date) from public, anon;
grant execute on function public.docs_ask_tally_counts(date) to authenticated, service_role;
grant execute on function public.docs_ask_tally_weekly(date) to authenticated, service_role;

commit;
