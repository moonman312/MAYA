-- ============================================================================
-- FIRST PAID AT — the one billing fact that is never overwritten
-- ============================================================================
--
-- hotel_subscriptions holds a subscription's CURRENT Stripe status, upserted in
-- place on every webhook. "Has this property ever actually paid us?" is not in
-- it anywhere: a trial that ran out, a card that failed and a customer of two
-- years who cancelled can all read 'canceled' today. The never-paid retention
-- sweep (99_supabase_migration_never_paid_retention_v1.sql) must be able to
-- tell those apart, because deleting a former customer's history is exactly
-- what it must never do.
--
-- first_paid_at is written once, by the Stripe webhook's
-- invoice.payment_succeeded handling (lib/billing/first-paid.ts), for an
-- invoice that is paid and charged more than zero. A trial's $0 invoice and a
-- 100%-off code do not count; money has to have moved. The row is keyed by
-- hotel and reused on a re-subscribe, so the column answers for the property,
-- not for one subscription: once set it stays, and a trigger holds it there
-- against any later write that is not a hand-run fix in the SQL editor.
--
-- BACKFILL (best effort, and deliberately generous). Stripe's invoice history
-- is not mirrored here, so the backfill works from what the database already
-- knows, earliest evidence first:
--   1. hotel_metrics_daily: the first day the nightly snapshot saw the hotel
--      'active' or 'past_due' on a Stripe plan with net MRR above zero.
--   2. product_events: the first subscription.active on a Stripe plan.
--   3. A subscription that is 'active' or 'past_due' right now: the end of its
--      trial if that has passed, otherwise when the row was created.
-- Internal plans (sandbox, demo, ours) are never stamped. Anything else stays
-- null. Generous because the two ways to be wrong are not equal: a stamp that
-- should not be there keeps a property's data a while longer, a missing one
-- could let the sweep delete the history of someone who paid. The exact
-- answer lives in Stripe; nothing here depends on it being exact.
--
-- Run AFTER 99_supabase_migration_billing_v1.sql,
-- 99_supabase_migration_internal_plan_v1.sql,
-- 99_supabase_migration_business_metrics_v1.sql and
-- 99_supabase_migration_product_events_v1.sql. Idempotent: the backfill only
-- fills nulls.
--
-- Deploy order: either. Code first: the webhook's write names a column that
-- is not there yet, logs a warning naming this file, and answers Stripe 200
-- as before; the payments it would have stamped are covered by the backfill
-- when this runs. This file first: the column is there and only the backfill
-- writes it until the code lands.
--
-- Must run BEFORE 99_supabase_migration_never_paid_retention_v1.sql, which
-- reads it.
--
-- NOT mirrored into 02_supabase_schema.sql yet — fold it in on the next
-- schema consolidation pass.

begin;

alter table public.hotel_subscriptions
  add column if not exists first_paid_at timestamptz;

comment on column public.hotel_subscriptions.first_paid_at is
  'When this property first paid a non-zero invoice. Written once by the Stripe webhook (invoice.payment_succeeded), '
  'never cleared by the app. Rows from before 2026-09-16 were backfilled from snapshots and events, generously. '
  'Null means no payment has been seen: the never-paid retention sweep keys on it.';

create or replace function public.hotel_subscriptions_keep_first_paid()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- A hand-run correction in the SQL editor is the one writer allowed to move it.
  if current_user in ('postgres', 'supabase_admin') then
    return new;
  end if;
  if old.first_paid_at is not null then
    new.first_paid_at := old.first_paid_at;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_hotel_subscriptions_keep_first_paid on public.hotel_subscriptions;
create trigger trg_hotel_subscriptions_keep_first_paid
  before update on public.hotel_subscriptions
  for each row
  execute function public.hotel_subscriptions_keep_first_paid();

revoke all on function public.hotel_subscriptions_keep_first_paid() from public, anon, authenticated;

-- ── Backfill ────────────────────────────────────────────────────────────────

update public.hotel_subscriptions s
   set first_paid_at = coalesce(
         (select min(m.day)::timestamp at time zone 'UTC'
            from public.hotel_metrics_daily m
           where m.hotel_id = s.hotel_id
             and m.plan_kind = 'stripe'
             and m.status in ('active', 'past_due')
             and m.net_mrr_cents > 0),
         (select min(e.occurred_at)
            from public.product_events e
           where e.hotel_id = s.hotel_id
             and e.event = 'subscription.active'
             and coalesce(e.properties->>'plan_kind', 'stripe') = 'stripe'),
         case
           when s.status in ('active', 'past_due') then
             case when s.trial_end is not null and s.trial_end < now() then s.trial_end else s.created_at end
         end
       )
 where s.first_paid_at is null
   and s.plan_kind = 'stripe';

commit;

-- Check afterwards:
--
--   select plan_kind, status, count(*) as subscriptions, count(first_paid_at) as stamped
--     from hotel_subscriptions group by 1, 2 order by 1, 2;
--
-- Compare against Stripe when it matters (the dashboard's invoice list, filtered
-- to paid and amount > 0, first invoice per customer).
