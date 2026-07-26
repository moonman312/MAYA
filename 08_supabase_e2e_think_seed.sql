-- ============================================================================
-- 08_supabase_e2e_think_seed.sql — E2E fixture: Think Reservations hotel
-- ============================================================================
-- Companion to 05 (Mews-style fixture). This one simulates a small inn whose
-- data arrived via a Think Reservations sync: Think-style room-type ids and
-- reservation ids, a `pms_connections` row of type 'think', and an
-- inn-shaped demand curve (weekend-heavy leisure).
--
-- PREREQ — create the hotel in the Command Center wizard FIRST:
--   /admin/hotels/new → name it exactly:  MAYA E2E Test Hotel 2
--   ⚠ Put something in the "enterprise id" field (e.g. think-e2e-property).
--     hotels.external_enterprise_id is UNIQUE NULLS NOT DISTINCT — two
--     wizard hotels with a blank enterprise id will collide and the second
--     insert fails. (This seed backfills a distinct id afterwards either
--     way, so create THIS hotel first if you left it blank.)
--   Suggested invitee for this hotel: scdeloach16+mayatest2@gmail.com
--
-- This seed does NOT create the hotel (that's the wizard's job in your test
-- pass) and does NOT touch the OAuth secret tables — the pms_connections row
-- simulates "connected" state for UI/status purposes only. Re-runnable.
--
-- Demand profile (offset d from seed day; isodow):    Rules that fire:
--   d 5..9          ~95%  "festival week" (sellout)    +12% sellout premium
--   d 40..55        ~25%  deep off-season              −8% midweek value
--   d 0..2          ~65%
--   Fri/Sat         ~90%                               +12% sellout premium
--   Sun             ~60%
--   Mon–Thu         ~40%  (d>30 → −8% midweek value)
-- Pickup: baselines 73h old for d 0..20, suppressed 3 room-nights per type
-- → net pickup 6 > 2 → "+$15 Inn Pickup Alert" on every d 0..20 stay date.
--
-- Expected published prices after POST /api/evaluate (same-day, Queen $189):
--   festival d5..9          189×1.12 + 15 = 226.68
--   Fri/Sat d0..20          226.68        (sellout + pickup)
--   Fri/Sat d21+            211.68        (sellout only — pickup DTA<21)
--   Sun/Mon–Thu d0..20      204.00        (pickup only)
--   Mon–Thu d31+ & off-season 173.88      (−8% midweek value, strict DTA>30)
--   Sun d31+ (not off-season) 189.00      (base, no rules)
-- King ($219) and Carriage House ($329) scale identically. No clamp fixture
-- here — floor/ceiling clamping is exercised by the 05 Budget room.
-- ============================================================================

do $$
declare
  v_hotel_name text := 'MAYA E2E Test Hotel 2';           -- edit if you named it differently
  v_admin_email text := 'scdeloach16+mayatest2@gmail.com';
  v_hotel_id  uuid;
  v_user_id   uuid;
  v_rule_id   uuid;
  v_all_rts   uuid[];
  v_res_count int;
  v_snap_count int;
begin
  -- ── 1. Find the wizard-created hotel ─────────────────────────────────────
  select id into v_hotel_id from public.hotels where name = v_hotel_name;
  if v_hotel_id is null then
    raise notice 'Hotel "%" not found. Create it in /admin/hotels/new first, then re-run this seed.', v_hotel_name;
    return;
  end if;

  update public.hotels
     set timezone = 'America/New_York', currency = 'USD', is_active = true,
         external_enterprise_id = 'think-e2e-property-001', updated_at = now()
   where id = v_hotel_id;

  -- Settings: only fill in if the wizard somehow didn't.
  insert into public.hotel_settings (hotel_id) values (v_hotel_id)
  on conflict (hotel_id) do nothing;

  -- ── 2. Room types — simulates a completed first Think sync ───────────────
  insert into public.room_types
    (hotel_id, external_room_type_id, name, display_name, is_active, total_rooms, floor_price, ceiling_price)
  values
    (v_hotel_id, 'think-1001', 'Queen Room',           'Queen Room',           true, 8, 120.00, 380.00),
    (v_hotel_id, 'think-1002', 'King Room',            'King Room',            true, 6, 150.00, 450.00),
    (v_hotel_id, 'think-1003', 'Carriage House Suite', 'Carriage House Suite', true, 3, 220.00, 700.00)
  on conflict (hotel_id, external_room_type_id) do update
    set name = excluded.name, display_name = excluded.display_name, is_active = true,
        total_rooms = excluded.total_rooms, floor_price = excluded.floor_price,
        ceiling_price = excluded.ceiling_price, updated_at = now();

  select array_agg(id) into v_all_rts from public.room_types where hotel_id = v_hotel_id;

  -- ── 3. PMS connection (status only; secrets stay with the real OAuth flow)
  insert into public.pms_connections (hotel_id, pms_type, status, base_url, last_tested_at, last_sync_at)
  values (v_hotel_id, 'think', 'connected', 'https://api.thinkreservations.com', now(), now())
  on conflict (hotel_id, pms_type) do update
    set status = 'connected', base_url = excluded.base_url,
        last_tested_at = now(), last_sync_at = now(), updated_at = now();

  -- ── 4. Membership (only if the invitee already accepted a prior invite) ──
  select id into v_user_id from auth.users where lower(email) = lower(v_admin_email);
  if v_user_id is not null then
    insert into public.hotel_memberships (hotel_id, user_id, role, status)
    values (v_hotel_id, v_user_id, 'hotel_admin', 'active')
    on conflict (hotel_id, user_id) do update set role = 'hotel_admin', status = 'active';
  else
    raise notice 'auth user % not found — invite them from /admin to exercise the Resend flow.', v_admin_email;
  end if;

  -- ── 5. Reservations (Think-style ids, deterministic inn demand) ──────────
  delete from public.reservations where hotel_id = v_hotel_id;

  insert into public.reservations
    (hotel_id, external_reservation_id, room_type_id, stay_date,
     booking_date, booking_window_days, current_rate, base_rate, raw_payload)
  select
    v_hotel_id,
    format('%s-%s-%s', rt.external_room_type_id, to_char(d.stay_date, 'YYYYMMDD'),
           lpad(seq::text, 3, '0')),
    rt.id,
    d.stay_date,
    d.stay_date - ((seq * 11) % 60 + 1),
    (seq * 11) % 60 + 1,
    rt.rate, rt.rate,
    jsonb_build_object('source', 'think_e2e_seed', 'pms', 'think')
  from (
    select gs::date as stay_date, (gs::date - current_date) as d_off
    from generate_series(current_date - 30, current_date + 120, interval '1 day') gs
  ) d
  cross join (
    select id, external_room_type_id, total_rooms,
           case external_room_type_id
             when 'think-1001' then 189.00
             when 'think-1002' then 219.00
             else 329.00 end as rate
    from public.room_types where hotel_id = v_hotel_id
  ) rt
  cross join lateral (
    select round(rt.total_rooms * (
      case
        when d.d_off between  5 and  9 then 0.95   -- festival week (sellout)
        when d.d_off between 40 and 55 then 0.25   -- deep off-season
        when d.d_off between  0 and  2 then 0.65
        when extract(isodow from d.stay_date) in (5, 6) then 0.90  -- Fri/Sat
        when extract(isodow from d.stay_date) = 7 then 0.60        -- Sun
        else 0.40                                                  -- Mon–Thu
      end)::numeric)::int as booked_count
  ) bc
  cross join lateral generate_series(1, bc.booked_count) seq;

  get diagnostics v_res_count = row_count;

  -- ── 6. Pickup baselines (d 0..20, −3 room-nights per type, 73h old) ──────
  delete from public.stay_date_snapshot where hotel_id = v_hotel_id;

  insert into public.stay_date_snapshot
    (hotel_id, snapshot_ts, stay_date, room_type_id, sellable_units, booked_units, booked_revenue)
  select
    v_hotel_id, now() - interval '73 hours', r.stay_date, rt.id, rt.total_rooms,
    greatest(count(*)::int - 3, 0),
    greatest(count(*)::int - 3, 0) * max(r.current_rate)
  from public.reservations r
  join public.room_types rt on rt.id = r.room_type_id
  where r.hotel_id = v_hotel_id
    and r.stay_date between current_date and current_date + 20
  group by r.stay_date, rt.id, rt.total_rooms;

  get diagnostics v_snap_count = row_count;

  -- ── 7. Clear stale engine output ─────────────────────────────────────────
  delete from public.published_price          where hotel_id = v_hotel_id;
  delete from public.evaluation_audit         where hotel_id = v_hotel_id;
  delete from public.ladder_transition_event  where hotel_id = v_hotel_id;
  delete from public.pickup_event             where hotel_id = v_hotel_id;

  -- ── 8. Rules ─────────────────────────────────────────────────────────────
  delete from public.pricing_rules where hotel_id = v_hotel_id;

  -- 8.1 Weekend Sellout Premium — occupancy > 85% → +12% (all rooms).
  insert into public.pricing_rules
    (hotel_id, name, is_active, action_type, action_direction, action_value, priority)
  values (v_hotel_id, 'Weekend Sellout Premium', true, 'percent', 'increase', 12, 100)
  returning id into v_rule_id;
  insert into public.rule_condition (rule_id, occupancy_operator, occupancy_threshold)
  values (v_rule_id, 'gt', 0.85);
  insert into public.rule_signal_room_type   select v_rule_id, unnest(v_all_rts);
  insert into public.rule_affected_room_type select v_rule_id, unnest(v_all_rts);

  -- 8.2 Midweek Value — occupancy < 45% AND DTA > 30 → −8%.
  insert into public.pricing_rules
    (hotel_id, name, is_active, action_type, action_direction, action_value, priority)
  values (v_hotel_id, 'Midweek Value', true, 'percent', 'decrease', 8, 90)
  returning id into v_rule_id;
  insert into public.rule_condition
    (rule_id, occupancy_operator, occupancy_threshold, dta_operator, dta_threshold_days)
  values (v_rule_id, 'lt', 0.45, 'gt', 30);
  insert into public.rule_signal_room_type   select v_rule_id, unnest(v_all_rts);
  insert into public.rule_affected_room_type select v_rule_id, unnest(v_all_rts);

  -- 8.3 Inn Pickup Alert — net pickup > 2 room-nights in 3 days, DTA < 21
  --     → +$15 (small property, small thresholds).
  insert into public.pricing_rules
    (hotel_id, name, is_active, action_type, action_direction, action_value, priority, is_pickup_rule)
  values (v_hotel_id, 'Inn Pickup Alert', true, 'fixed', 'increase', 15, 110, true)
  returning id into v_rule_id;
  insert into public.rule_condition
    (rule_id, dta_operator, dta_threshold_days,
     pickup_operator, pickup_threshold, pickup_window_days, pickup_metric)
  values (v_rule_id, 'lt', 21, 'gt', 2, 3, 'room_nights');
  insert into public.rule_signal_room_type   select v_rule_id, unnest(v_all_rts);
  insert into public.rule_affected_room_type select v_rule_id, unnest(v_all_rts);

  raise notice '==========================================================';
  raise notice 'MAYA E2E Test Hotel 2 seeded (hotel_id = %).', v_hotel_id;
  raise notice '  reservations = % rows, snapshots = % baseline rows', v_res_count, v_snap_count;
  raise notice '  rules = 3 active, pms_connections = think/connected';
  raise notice 'Next: invite %, then POST /api/evaluate within ~11h.', v_admin_email;
  raise notice '==========================================================';
end $$;

-- ── Quick checks (expect pass = true everywhere) ─────────────────────────────
with h as (select id from public.hotels where name = 'MAYA E2E Test Hotel 2')
select * from (
  select 1 as ord, 'hotel found + think enterprise id backfilled' as check,
    exists(select 1 from public.hotels where id = (select id from h)
           and external_enterprise_id = 'think-e2e-property-001') as pass
  union all
  select 2, '3 room types with think-* external ids',
    (select count(*) from public.room_types
     where hotel_id = (select id from h) and external_room_type_id like 'think-%' and is_active) = 3
  union all
  select 3, 'pms_connections row: think / connected',
    exists(select 1 from public.pms_connections
           where hotel_id = (select id from h) and pms_type = 'think' and status = 'connected')
  union all
  select 4, 'reservations cover 151 stay dates',
    (select count(distinct stay_date) from public.reservations
     where hotel_id = (select id from h)) = 151
  union all
  select 5, 'festival week sold out (day0+7: 8+6+3 = 17 booked)',
    (select count(*) from public.reservations
     where hotel_id = (select id from h)
       and stay_date = (select min(stay_date) + 37 from public.reservations
                        where hotel_id = (select id from h))) = 17
  union all
  select 6, '3 rules (1 pickup), 21×3 baseline snapshots',
    (select count(*) from public.pricing_rules where hotel_id = (select id from h)) = 3
    and (select count(*) from public.pricing_rules
         where hotel_id = (select id from h) and is_pickup_rule) = 1
    and (select count(*) from public.stay_date_snapshot
         where hotel_id = (select id from h)) = 63
) checks order by ord;
