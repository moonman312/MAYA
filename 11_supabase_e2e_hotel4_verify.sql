-- ============================================================================
-- 11_supabase_e2e_hotel4_verify.sql — watch the CRON manage MAYA E2E Test Hotel 4
-- ============================================================================
-- Run these AFTER seeding (10_...) and after at least one cron tick (≤5 min).
-- Each block is standalone; run individually in the SQL editor. Re-run block B
-- every few minutes to watch the run count climb as the cron fires.
-- ============================================================================

-- ── A. Fixture is in place ──────────────────────────────────────────────────
with h as (select id from public.hotels where name = 'MAYA E2E Test Hotel 4')
select
  (select count(*) from public.room_types   where hotel_id = (select id from h)) as room_types,
  (select count(*) from public.reservations where hotel_id = (select id from h)) as reservation_rows,
  (select count(*) from public.pricing_rules where hotel_id = (select id from h)) as rules,
  (select count(*) from public.pricing_rules where hotel_id = (select id from h) and is_pickup_rule) as pickup_rules;
-- expect: room_types=4, reservation_rows≈ (varies), rules=4, pickup_rules=1


-- ── B. IS THE CRON EVALUATING? (primary signal — re-run every few minutes) ──
-- The engine writes one evaluation_audit row per (run, stay_date, room_type)
-- EVERY tick, even when prices don't change. So distinct runs = cron fires.
with h as (select id from public.hotels where name = 'MAYA E2E Test Hotel 4')
select
  count(distinct evaluation_run_id)                          as eval_runs_total,
  max(evaluated_at)                                          as last_eval_at,
  round(extract(epoch from (now() - max(evaluated_at)))/60.0, 1) as minutes_since_last_eval
from public.evaluation_audit
where hotel_id = (select id from h);
-- expect: eval_runs_total increases by 1 every ~5 min; minutes_since_last_eval < 5.
-- If eval_runs_total stays 0: the cloudbeds cron isn't reaching evaluate — check
-- Edge logs for cloudbeds-scheduled-sync and that the pms_connections row exists.


-- ── C. Prices are published ─────────────────────────────────────────────────
with h as (select id from public.hotels where name = 'MAYA E2E Test Hotel 4')
select
  count(*)                                                   as priced_night_rows,
  count(distinct stay_date)                                  as priced_dates,
  min(price) as min_price, max(price) as max_price,
  max(computed_at)                                           as last_price_change
from public.published_price
where hotel_id = (select id from h);
-- published_price is diff-only: computed_at only advances when a price actually
-- changes, so it may lag last_eval_at once prices stabilize — that's expected.


-- ── D. HEADLINE ASSERTION: Penthouse clamps at ceiling on event days ────────
-- 420 base ×1.10 ×1.20 (×1.08 pickup) = 554–599 > 500 ceiling → exactly 500.00.
with h as (select id from public.hotels where name = 'MAYA E2E Test Hotel 4')
select pp.stay_date, rt.name, pp.price,
       (pp.price = 500.00) as clamped_ok
from public.published_price pp
join public.room_types rt on rt.id = pp.room_type_id
where pp.hotel_id = (select id from h)
  and rt.external_room_type_id = 'cb4-204'                 -- Penthouse
  and pp.stay_date between current_date + 12 and current_date + 14
order by pp.stay_date;
-- expect: price = 500.00, clamped_ok = true for each event day.


-- ── E. See day-of-week variation (Standard Queen, next 14 nights) ───────────
with h as (select id from public.hotels where name = 'MAYA E2E Test Hotel 4')
select pp.stay_date,
       to_char(pp.stay_date, 'Dy')                          as dow,
       pp.price
from public.published_price pp
join public.room_types rt on rt.id = pp.room_type_id
where pp.hotel_id = (select id from h)
  and rt.external_room_type_id = 'cb4-201'                 -- Standard Queen ($145 base)
  and pp.stay_date between current_date and current_date + 14
order by pp.stay_date;
-- Tue–Thu should sit above $145 (compression), Fri–Sun below on d>14 (leisure
-- deal). Add ~+8% while the pickup baseline is still fresh (first ~11h).


-- ── F. Rule activity (ladder transitions + pickup events) ───────────────────
with h as (select id from public.hotels where name = 'MAYA E2E Test Hotel 4')
select
  (select count(*) from public.ladder_transition_event where hotel_id = (select id from h)) as ladder_transitions,
  (select count(*) from public.pickup_event          where hotel_id = (select id from h) and retired_at is null) as active_pickup_events;


-- ── G. Cloudbeds cron health (HTTP dispatch layer) ──────────────────────────
select j.jobname, d.status, left(coalesce(d.return_message,''), 60) as msg, d.start_time
from cron.job_run_details d
join cron.job j using (jobid)
where j.jobname = 'cloudbeds-sync-every-5-min'
order by d.start_time desc
limit 6;


-- ── H. Sync status note ─────────────────────────────────────────────────────
-- For THIS fixture (no Vault secret) the sync step returns ok:false and changes
-- nothing: status stays 'connected' and last_sync_at stays NULL. This is
-- EXPECTED and does not stop evaluation. last_sync_at only advances once you
-- OAuth-connect real Cloudbeds credentials and a real sync succeeds.
select hotel_id, pms_type, status, last_sync_at, last_tested_at
from public.pms_connections
where hotel_id = (select id from public.hotels where name = 'MAYA E2E Test Hotel 4')
  and pms_type = 'cloudbeds';
