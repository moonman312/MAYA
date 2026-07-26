-- ============================================================================
-- 05_supabase_e2e_test_seed.sql — E2E test fixture: "MAYA E2E Test Hotel"
-- ============================================================================
-- Run in Supabase SQL Editor (service role) AFTER 01 + 02 are applied.
-- Safe to re-run: every section is delete-then-insert or upsert, scoped to
-- this one hotel. Nothing here touches the three 03_seed hotels.
--
-- What it creates:
--   * Hotel "MAYA E2E Test Hotel" (tz Europe/Istanbul) + settings
--   * 4 room types with REAL floor/ceiling bands (Budget's ceiling is tight
--     on purpose so rule adjustments visibly clamp)
--   * ~151 days of reservations (today-30 .. today+120) with a DETERMINISTIC
--     occupancy profile designed to cross every rule threshold:
--       - day offset  7..13  → ~90% occupancy   ("compression week")
--       - day offset 45..60  → ~30% occupancy   ("soft period")
--       - day offset  0..2   → ~70% occupancy   (last-minute window)
--       - otherwise Fri/Sat ~85%, Wed/Thu ~65%, Sun-Tue ~45%
--     Rates are flat per room type (no jitter) so ADR and rule math are
--     exactly predictable: STD $175, DLX $245, STE $395, BGT $110.
--   * Baseline stay_date_snapshot rows 73h in the past for stay dates
--     today..today+29, with booked_units suppressed (STE −8, others −4) so
--     pickup rules have history and compute a positive net pickup on the
--     FIRST /api/evaluate run.  ⚠ The engine's staleness guard is 12h, so
--     run /api/evaluate within ~11 hours of seeding (or just re-run this
--     script to refresh baselines).
--   * 7 pricing rules (6 active + 1 disabled, for the toggle test).
--
-- What it deliberately does NOT create:
--   * The auth user / membership / pending invite for
--     scdeloach16+mayatest@gmail.com — invite them through the Command
--     Center (/admin) so the full Resend email → accept-invite → membership
--     trigger chain is exercised end-to-end. (If the auth user already
--     exists from a previous run, the membership is upserted below so
--     re-seeding never locks them out.)
--   * published_price / audit rows — those must appear only after
--     POST /api/evaluate; the verify script asserts exact values.
-- ============================================================================

do $$
declare
  v_hotel_id    uuid;
  v_admin_email text := 'scdeloach16+mayatest@gmail.com';
  v_user_id     uuid;
  v_rule_id     uuid;
  v_all_rts     uuid[];
  v_ste_rt      uuid;
  v_bgt_rt      uuid;
  v_res_count   int;
  v_snap_count  int;
begin
  -- ── 1. Hotel ─────────────────────────────────────────────────────────────
  select id into v_hotel_id from public.hotels where name = 'MAYA E2E Test Hotel';
  if v_hotel_id is null then
    insert into public.hotels
      (name, timezone, currency, is_active, total_rooms_per_type, external_enterprise_id)
    values
      ('MAYA E2E Test Hotel', 'Europe/Istanbul', 'USD', true, 100, 'enterprise-maya-e2e-test')
    returning id into v_hotel_id;
  else
    update public.hotels
       set timezone = 'Europe/Istanbul', currency = 'USD', is_active = true,
           external_enterprise_id = 'enterprise-maya-e2e-test', updated_at = now()
     where id = v_hotel_id;
  end if;

  -- ── 2. Settings ──────────────────────────────────────────────────────────
  insert into public.hotel_settings
    (hotel_id, pricing_horizon_days, pickup_window_cycles, simulation_mode, rounding_mode)
  values (v_hotel_id, 365, 1, true, 'none')
  on conflict (hotel_id) do update
    set pricing_horizon_days = 365, pickup_window_cycles = 1,
        simulation_mode = true, rounding_mode = 'none', updated_at = now();

  -- ── 3. Room types (floor/ceiling chosen so clamping is testable) ─────────
  insert into public.room_types
    (hotel_id, external_room_type_id, name, display_name, is_active, total_rooms, floor_price, ceiling_price)
  values
    (v_hotel_id, 'STD', 'Standard', 'Standard Room', true, 40,  90.00,  400.00),
    (v_hotel_id, 'DLX', 'Deluxe',   'Deluxe Room',   true, 30, 140.00,  600.00),
    (v_hotel_id, 'STE', 'Suite',    'Suite',         true, 15, 220.00, 1200.00),
    -- Budget: $110 base inside a 95–120 band → any upward rule stack clamps
    -- at the $120 ceiling; "Winter Promo" (−$10) pushes soft-period nights
    -- to the $95 floor once you enable it.
    (v_hotel_id, 'BGT', 'Budget',   'Budget Room',   true, 20,  95.00,  120.00)
  on conflict (hotel_id, external_room_type_id) do update
    set name = excluded.name, display_name = excluded.display_name, is_active = true,
        total_rooms = excluded.total_rooms, floor_price = excluded.floor_price,
        ceiling_price = excluded.ceiling_price, updated_at = now();

  select array_agg(id) into v_all_rts from public.room_types where hotel_id = v_hotel_id;
  select id into v_ste_rt from public.room_types where hotel_id = v_hotel_id and external_room_type_id = 'STE';
  select id into v_bgt_rt from public.room_types where hotel_id = v_hotel_id and external_room_type_id = 'BGT';

  -- ── 4. Membership (only if the invitee already accepted a prior invite) ──
  select id into v_user_id from auth.users where lower(email) = lower(v_admin_email);
  if v_user_id is not null then
    insert into public.hotel_memberships (hotel_id, user_id, role, status)
    values (v_hotel_id, v_user_id, 'hotel_admin', 'active')
    on conflict (hotel_id, user_id) do update set role = 'hotel_admin', status = 'active';
    raise notice 'auth user % already exists — hotel_admin membership ensured.', v_admin_email;
  else
    raise notice 'auth user % not found — invite them from /admin to exercise the Resend flow.', v_admin_email;
  end if;

  -- ── 5. Reservations (deterministic occupancy, flat rates) ────────────────
  delete from public.reservations where hotel_id = v_hotel_id;

  insert into public.reservations
    (hotel_id, external_reservation_id, room_type_id, stay_date,
     booking_date, booking_window_days, current_rate, base_rate, raw_payload)
  select
    v_hotel_id,
    format('e2e-%s-%s-%s', rt.external_room_type_id, to_char(d.stay_date, 'YYYYMMDD'),
           lpad(seq::text, 3, '0')),
    rt.id,
    d.stay_date,
    d.stay_date - ((seq * 7) % 45 + 1),
    (seq * 7) % 45 + 1,
    rt.rate, rt.rate,
    jsonb_build_object('source', 'e2e_seed')
  from (
    select gs::date as stay_date, (gs::date - current_date) as d_off
    from generate_series(current_date - 30, current_date + 120, interval '1 day') gs
  ) d
  cross join (
    select id, external_room_type_id, total_rooms,
           case external_room_type_id
             when 'STD' then 175.00 when 'DLX' then 245.00
             when 'STE' then 395.00 else 110.00 end as rate
    from public.room_types where hotel_id = v_hotel_id
  ) rt
  cross join lateral (
    select round(rt.total_rooms * (
      case
        when d.d_off between  7 and 13 then 0.90   -- compression week
        when d.d_off between 45 and 60 then 0.30   -- soft period
        when d.d_off between  0 and  2 then 0.70   -- last-minute window
        when extract(isodow from d.stay_date) in (5, 6) then 0.85  -- Fri/Sat
        when extract(isodow from d.stay_date) in (3, 4) then 0.65  -- Wed/Thu
        else 0.45                                                  -- Sun-Tue
      end)::numeric)::int as booked_count
  ) bc
  cross join lateral generate_series(1, bc.booked_count) seq;

  get diagnostics v_res_count = row_count;

  -- ── 6. Pickup baseline snapshots (73h old; refresh by re-running) ────────
  -- booked_units suppressed vs today's reservations: STE −8, others −4.
  -- With 3-day pickup windows this yields net pickup of 8 (STE; >5 fires
  -- "Suite Pickup Surge") and 4 (others; >3 fires "Property Pickup Bump")
  -- for every stay date in today..today+29.
  delete from public.stay_date_snapshot where hotel_id = v_hotel_id;

  insert into public.stay_date_snapshot
    (hotel_id, snapshot_ts, stay_date, room_type_id, sellable_units, booked_units, booked_revenue)
  select
    v_hotel_id,
    now() - interval '73 hours',
    r.stay_date,
    rt.id,
    rt.total_rooms,
    greatest(count(*)::int - (case when rt.external_room_type_id = 'STE' then 8 else 4 end), 0),
    greatest(count(*)::int - (case when rt.external_room_type_id = 'STE' then 8 else 4 end), 0)
      * max(r.current_rate)
  from public.reservations r
  join public.room_types rt on rt.id = r.room_type_id
  where r.hotel_id = v_hotel_id
    and r.stay_date between current_date and current_date + 29
  group by r.stay_date, rt.id, rt.total_rooms, rt.external_room_type_id;

  get diagnostics v_snap_count = row_count;

  -- ── 7. Clear stale engine output from previous runs ──────────────────────
  -- (pickup_event / ladder_* cascade away with the rules below; these don't.)
  delete from public.published_price   where hotel_id = v_hotel_id;
  delete from public.evaluation_audit  where hotel_id = v_hotel_id;
  delete from public.ladder_transition_event where hotel_id = v_hotel_id;

  -- ── 8. Pricing rules ─────────────────────────────────────────────────────
  delete from public.pricing_rules where hotel_id = v_hotel_id;

  -- 8.1 High Occupancy Surge — occupancy > 80% → +10% (ladder, all rooms).
  --     Fires on compression week + Fri/Sat.
  insert into public.pricing_rules
    (hotel_id, name, is_active, action_type, action_direction, action_value, priority)
  values (v_hotel_id, 'High Occupancy Surge', true, 'percent', 'increase', 10, 100)
  returning id into v_rule_id;
  insert into public.rule_condition (rule_id, occupancy_operator, occupancy_threshold)
  values (v_rule_id, 'gt', 0.80);
  insert into public.rule_signal_room_type   select v_rule_id, unnest(v_all_rts);
  insert into public.rule_affected_room_type select v_rule_id, unnest(v_all_rts);

  -- 8.2 Last-Minute Compression — occupancy > 50% AND DTA < 3 → +15%.
  --     Fires on stay dates 0..2 days out (~70% occupancy).
  insert into public.pricing_rules
    (hotel_id, name, is_active, action_type, action_direction, action_value, priority)
  values (v_hotel_id, 'Last-Minute Compression', true, 'percent', 'increase', 15, 110)
  returning id into v_rule_id;
  insert into public.rule_condition
    (rule_id, occupancy_operator, occupancy_threshold, dta_operator, dta_threshold_days)
  values (v_rule_id, 'gt', 0.50, 'lt', 3);
  insert into public.rule_signal_room_type   select v_rule_id, unnest(v_all_rts);
  insert into public.rule_affected_room_type select v_rule_id, unnest(v_all_rts);

  -- 8.3 Early Bird Soft Demand — occupancy < 40% AND DTA > 45 → −5%.
  --     Fires on the soft period (note: strictly >45, so day 46 onward).
  insert into public.pricing_rules
    (hotel_id, name, is_active, action_type, action_direction, action_value, priority)
  values (v_hotel_id, 'Early Bird Soft Demand', true, 'percent', 'decrease', 5, 90)
  returning id into v_rule_id;
  insert into public.rule_condition
    (rule_id, occupancy_operator, occupancy_threshold, dta_operator, dta_threshold_days)
  values (v_rule_id, 'lt', 0.40, 'gt', 45);
  insert into public.rule_signal_room_type   select v_rule_id, unnest(v_all_rts);
  insert into public.rule_affected_room_type select v_rule_id, unnest(v_all_rts);

  -- 8.4 Suite Pickup Surge — net pickup > 5 room-nights in 3 days, DTA < 30
  --     → +$50 on Suites. Priority 120 so it BEATS 8.5 in per-room pickup
  --     competition on Suites (deterministic tie-break test).
  --     (is_pickup_rule set explicitly AND synced by the rule_condition
  --     trigger — belt and braces in case the trigger predates this DB.)
  insert into public.pricing_rules
    (hotel_id, name, is_active, action_type, action_direction, action_value, priority, is_pickup_rule)
  values (v_hotel_id, 'Suite Pickup Surge', true, 'fixed', 'increase', 50, 120, true)
  returning id into v_rule_id;
  insert into public.rule_condition
    (rule_id, dta_operator, dta_threshold_days,
     pickup_operator, pickup_threshold, pickup_window_days, pickup_metric)
  values (v_rule_id, 'lt', 30, 'gt', 5, 3, 'room_nights');
  insert into public.rule_signal_room_type   values (v_rule_id, v_ste_rt);
  insert into public.rule_affected_room_type values (v_rule_id, v_ste_rt);

  -- 8.5 Property Pickup Bump — net pickup > 3 room-nights in 3 days,
  --     DTA < 30 → +5% everywhere. Loses to 8.4 on Suites; wins elsewhere.
  insert into public.pricing_rules
    (hotel_id, name, is_active, action_type, action_direction, action_value, priority, is_pickup_rule)
  values (v_hotel_id, 'Property Pickup Bump', true, 'percent', 'increase', 5, 100, true)
  returning id into v_rule_id;
  insert into public.rule_condition
    (rule_id, dta_operator, dta_threshold_days,
     pickup_operator, pickup_threshold, pickup_window_days, pickup_metric)
  values (v_rule_id, 'lt', 30, 'gt', 3, 3, 'room_nights');
  insert into public.rule_signal_room_type   select v_rule_id, unnest(v_all_rts);
  insert into public.rule_affected_room_type select v_rule_id, unnest(v_all_rts);

  -- 8.6 Budget Compression Premium — Budget occupancy > 60% → +25% on
  --     Budget only. Stacks with 8.1/8.2/8.5 and slams into the $120
  --     ceiling → clamped_by='ceiling' in evaluation_audit.
  insert into public.pricing_rules
    (hotel_id, name, is_active, action_type, action_direction, action_value, priority)
  values (v_hotel_id, 'Budget Compression Premium', true, 'percent', 'increase', 25, 105)
  returning id into v_rule_id;
  insert into public.rule_condition (rule_id, occupancy_operator, occupancy_threshold)
  values (v_rule_id, 'gt', 0.60);
  insert into public.rule_signal_room_type   values (v_rule_id, v_bgt_rt);
  insert into public.rule_affected_room_type values (v_rule_id, v_bgt_rt);

  -- 8.7 Winter Promo — DISABLED. Budget occupancy < 35% → −$10.
  --     Toggle it on in the Rules tab, re-evaluate, and soft-period Budget
  --     nights drop 110×0.95−10 = 94.50 → clamped UP to the $95 floor.
  insert into public.pricing_rules
    (hotel_id, name, is_active, action_type, action_direction, action_value, priority)
  values (v_hotel_id, 'Winter Promo (disabled)', false, 'fixed', 'decrease', 10, 95)
  returning id into v_rule_id;
  insert into public.rule_condition (rule_id, occupancy_operator, occupancy_threshold)
  values (v_rule_id, 'lt', 0.35);
  insert into public.rule_signal_room_type   values (v_rule_id, v_bgt_rt);
  insert into public.rule_affected_room_type values (v_rule_id, v_bgt_rt);

  -- ── Done ─────────────────────────────────────────────────────────────────
  raise notice '======================================================';
  raise notice 'MAYA E2E Test Hotel seeded.';
  raise notice '  hotel_id      = %', v_hotel_id;
  raise notice '  reservations  = % rows (% .. %)', v_res_count, current_date - 30, current_date + 120;
  raise notice '  snapshots     = % baseline rows @ now()-73h', v_snap_count;
  raise notice '  rules         = 7 (6 active, 1 disabled)';
  raise notice 'Next: invite % from /admin, then POST /api/evaluate', v_admin_email;
  raise notice '      within ~11h of this seed (pickup staleness guard).';
  raise notice '======================================================';
end $$;
