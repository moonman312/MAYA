-- ============================================================================
-- 09_supabase_e2e_cloudbeds_seed.sql — E2E fixture: Cloudbeds hotel
-- ============================================================================
-- Companion to 05 (Mews) and 08 (Think). Simulates a mid-size urban business
-- hotel whose data arrived via a Cloudbeds sync: Cloudbeds-style numeric
-- room-type / reservation ids, a `pms_connections` row of type 'cloudbeds',
-- and an inverted (business) demand curve — strong midweek, soft weekends —
-- so cross-hotel calendar isolation is obvious at a glance next to 05/08.
--
-- PREREQ — create the hotel in the Command Center wizard FIRST:
--   /admin/hotels/new → name it exactly:  MAYA E2E Test Hotel 3
--   ⚠ Put something in the "enterprise id" field (e.g. cb-e2e-property).
--     hotels.external_enterprise_id is UNIQUE NULLS NOT DISTINCT — two
--     wizard hotels with a blank enterprise id collide and the second
--     insert fails. (This seed backfills a distinct id afterwards.)
--   Suggested invitee for this hotel: scdeloach16+mayatest3@gmail.com
--
-- Demand profile (offset d; isodow):                  Rules that fire:
--   d 12..14        ~98%  "citywide event"            +10% AND +20% (stacking)
--   d 50..65        ~30%  convention drought          −10% leisure deal (DTA>14)
--   d 0..2          ~75%
--   Tue/Wed/Thu     ~85%  corporate base              +10% compression
--   Mon             ~70%
--   Fri/Sat         ~50%  (d>14 → −10% leisure deal)
--   Sun             ~40%  (d>14 → −10% leisure deal)
-- Pickup: baselines 73h old for d 0..29, suppressed 4 room-nights per type
-- → net pickup ≥ 14 > 10 → "+8% Citywide Pickup Surge" on every d 0..29.
--
-- Expected published prices after POST /api/evaluate (same-day, SQ $145):
--   event d12..14      145×1.10×1.20×1.08 = 206.71   (both ladders + pickup)
--     └ Penthouse      420×1.10×1.20×1.08 = 598.75 → CLAMPED at 500 ceiling
--   Tue–Thu d0..29     145×1.10×1.08      = 172.26
--   Tue–Thu d30+       145×1.10           = 159.50
--   Fri–Sun d15..29    145×0.90×1.08      = 140.94   (deal + pickup coexist)
--   Fri–Sun d30+ & drought 145×0.90       = 130.50
--   Mon/Fri–Sun d0..14 145×1.08           = 156.60   (pickup only)
--   Mon d30+           145.00              (base, no rules)
-- ============================================================================

do $$
declare
  v_hotel_name text := 'MAYA E2E Test Hotel 3';       -- edit if you named it differently
  v_admin_email text := 'scdeloach16+mayatest3@gmail.com';
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
     set timezone = 'America/Chicago', currency = 'USD', is_active = true,
         external_enterprise_id = 'cb-e2e-property-540200', updated_at = now()
   where id = v_hotel_id;

  insert into public.hotel_settings (hotel_id) values (v_hotel_id)
  on conflict (hotel_id) do nothing;

  -- ── 2. Room types — simulates a completed first Cloudbeds sync ───────────
  insert into public.room_types
    (hotel_id, external_room_type_id, name, display_name, is_active, total_rooms, floor_price, ceiling_price)
  values
    (v_hotel_id, 'cb-540211', 'Standard Queen', 'Standard Queen', true, 30,  95.00, 300.00),
    (v_hotel_id, 'cb-540212', 'Double Double',  'Double Double',  true, 25,  90.00, 280.00),
    (v_hotel_id, 'cb-540213', 'King Deluxe',    'King Deluxe',    true, 20, 120.00, 400.00),
    -- Penthouse: $420 base under a $500 ceiling → the event-week rule stack
    -- (×1.10 ×1.20 ×1.08 = $598.75) must clamp at the ceiling.
    (v_hotel_id, 'cb-540214', 'Penthouse',      'Penthouse',      true,  5, 250.00, 500.00)
  on conflict (hotel_id, external_room_type_id) do update
    set name = excluded.name, display_name = excluded.display_name, is_active = true,
        total_rooms = excluded.total_rooms, floor_price = excluded.floor_price,
        ceiling_price = excluded.ceiling_price, updated_at = now();

  select array_agg(id) into v_all_rts from public.room_types where hotel_id = v_hotel_id;

  -- ── 3. PMS connection (status only; secrets stay with the real OAuth flow)
  insert into public.pms_connections (hotel_id, pms_type, status, base_url, last_tested_at, last_sync_at)
  values (v_hotel_id, 'cloudbeds', 'connected', 'https://api.cloudbeds.com', now(), now())
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

  -- ── 5. Reservations (Cloudbeds-style ids, business-hotel demand) ─────────
  delete from public.reservations where hotel_id = v_hotel_id;

  insert into public.reservations
    (hotel_id, external_reservation_id, room_type_id, stay_date,
     booking_date, booking_window_days, current_rate, base_rate, raw_payload)
  select
    v_hotel_id,
    format('cb-%s-%s', to_char(d.stay_date, 'YYMMDD'),
           lpad(((hashtext(rt.external_room_type_id) & 1023) * 1000 + seq)::text, 7, '0')),
    rt.id,
    d.stay_date,
    d.stay_date - ((seq * 5) % 28 + 1),
    (seq * 5) % 28 + 1,
    rt.rate, rt.rate,
    jsonb_build_object('source', 'cloudbeds_e2e_seed', 'pms', 'cloudbeds')
  from (
    select gs::date as stay_date, (gs::date - current_date) as d_off
    from generate_series(current_date - 30, current_date + 120, interval '1 day') gs
  ) d
  cross join (
    select id, external_room_type_id, total_rooms,
           case external_room_type_id
             when 'cb-540211' then 145.00
             when 'cb-540212' then 135.00
             when 'cb-540213' then 185.00
             else 420.00 end as rate
    from public.room_types where hotel_id = v_hotel_id
  ) rt
  cross join lateral (
    select round(rt.total_rooms * (
      case
        when d.d_off between 12 and 14 then 0.98   -- citywide event
        when d.d_off between 50 and 65 then 0.30   -- convention drought
        when d.d_off between  0 and  2 then 0.75
        when extract(isodow from d.stay_date) in (2, 3, 4) then 0.85  -- Tue–Thu
        when extract(isodow from d.stay_date) = 1 then 0.70           -- Mon
        when extract(isodow from d.stay_date) in (5, 6) then 0.50     -- Fri/Sat
        else 0.40                                                     -- Sun
      end)::numeric)::int as booked_count
  ) bc
  cross join lateral generate_series(1, bc.booked_count) seq;

  get diagnostics v_res_count = row_count;

  -- ── 6. Pickup baselines (d 0..29, −4 room-nights per type, 73h old) ──────
  delete from public.stay_date_snapshot where hotel_id = v_hotel_id;

  insert into public.stay_date_snapshot
    (hotel_id, snapshot_ts, stay_date, room_type_id, sellable_units, booked_units, booked_revenue)
  select
    v_hotel_id, now() - interval '73 hours', r.stay_date, rt.id, rt.total_rooms,
    greatest(count(*)::int - 4, 0),
    greatest(count(*)::int - 4, 0) * max(r.current_rate)
  from public.reservations r
  join public.room_types rt on rt.id = r.room_type_id
  where r.hotel_id = v_hotel_id
    and r.stay_date between current_date and current_date + 29
  group by r.stay_date, rt.id, rt.total_rooms;

  get diagnostics v_snap_count = row_count;

  -- ── 7. Clear stale engine output ─────────────────────────────────────────
  delete from public.published_price          where hotel_id = v_hotel_id;
  delete from public.evaluation_audit         where hotel_id = v_hotel_id;
  delete from public.ladder_transition_event  where hotel_id = v_hotel_id;
  delete from public.pickup_event             where hotel_id = v_hotel_id;

  -- ── 8. Rules ─────────────────────────────────────────────────────────────
  delete from public.pricing_rules where hotel_id = v_hotel_id;

  -- 8.1 Corporate Compression — occupancy > 80% → +10%.
  insert into public.pricing_rules
    (hotel_id, name, is_active, action_type, action_direction, action_value, priority)
  values (v_hotel_id, 'Corporate Compression', true, 'percent', 'increase', 10, 100)
  returning id into v_rule_id;
  insert into public.rule_condition (rule_id, occupancy_operator, occupancy_threshold)
  values (v_rule_id, 'gt', 0.80);
  insert into public.rule_signal_room_type   select v_rule_id, unnest(v_all_rts);
  insert into public.rule_affected_room_type select v_rule_id, unnest(v_all_rts);

  -- 8.2 Event Surge — occupancy > 95% → +20%. On event days BOTH 8.1 and
  --     8.2 are active → multiplicative ladder stacking (×1.10 ×1.20).
  insert into public.pricing_rules
    (hotel_id, name, is_active, action_type, action_direction, action_value, priority)
  values (v_hotel_id, 'Event Surge', true, 'percent', 'increase', 20, 120)
  returning id into v_rule_id;
  insert into public.rule_condition (rule_id, occupancy_operator, occupancy_threshold)
  values (v_rule_id, 'gt', 0.95);
  insert into public.rule_signal_room_type   select v_rule_id, unnest(v_all_rts);
  insert into public.rule_affected_room_type select v_rule_id, unnest(v_all_rts);

  -- 8.3 Weekend Leisure Deal — occupancy < 55% AND DTA > 14 → −10%.
  insert into public.pricing_rules
    (hotel_id, name, is_active, action_type, action_direction, action_value, priority)
  values (v_hotel_id, 'Weekend Leisure Deal', true, 'percent', 'decrease', 10, 90)
  returning id into v_rule_id;
  insert into public.rule_condition
    (rule_id, occupancy_operator, occupancy_threshold, dta_operator, dta_threshold_days)
  values (v_rule_id, 'lt', 0.55, 'gt', 14);
  insert into public.rule_signal_room_type   select v_rule_id, unnest(v_all_rts);
  insert into public.rule_affected_room_type select v_rule_id, unnest(v_all_rts);

  -- 8.4 Citywide Pickup Surge — net pickup > 10 room-nights in 3 days,
  --     DTA < 30 → +8% (bigger hotel, bigger thresholds than 08's inn).
  insert into public.pricing_rules
    (hotel_id, name, is_active, action_type, action_direction, action_value, priority, is_pickup_rule)
  values (v_hotel_id, 'Citywide Pickup Surge', true, 'percent', 'increase', 8, 110, true)
  returning id into v_rule_id;
  insert into public.rule_condition
    (rule_id, dta_operator, dta_threshold_days,
     pickup_operator, pickup_threshold, pickup_window_days, pickup_metric)
  values (v_rule_id, 'lt', 30, 'gt', 10, 3, 'room_nights');
  insert into public.rule_signal_room_type   select v_rule_id, unnest(v_all_rts);
  insert into public.rule_affected_room_type select v_rule_id, unnest(v_all_rts);

  raise notice '==========================================================';
  raise notice 'MAYA E2E Test Hotel 3 seeded (hotel_id = %).', v_hotel_id;
  raise notice '  reservations = % rows, snapshots = % baseline rows', v_res_count, v_snap_count;
  raise notice '  rules = 4 active, pms_connections = cloudbeds/connected';
  raise notice 'Next: invite %, then POST /api/evaluate within ~11h.', v_admin_email;
  raise notice 'Headline assertion: Penthouse event days clamp at 500.00.';
  raise notice '==========================================================';
end $$;

-- ── Quick checks (expect pass = true everywhere) ─────────────────────────────
with h as (select id from public.hotels where name = 'MAYA E2E Test Hotel 3')
select * from (
  select 1 as ord, 'hotel found + cloudbeds enterprise id backfilled' as check,
    exists(select 1 from public.hotels where id = (select id from h)
           and external_enterprise_id = 'cb-e2e-property-540200') as pass
  union all
  select 2, '4 room types with cb-* external ids',
    (select count(*) from public.room_types
     where hotel_id = (select id from h) and external_room_type_id like 'cb-%' and is_active) = 4
  union all
  select 3, 'pms_connections row: cloudbeds / connected',
    exists(select 1 from public.pms_connections
           where hotel_id = (select id from h) and pms_type = 'cloudbeds' and status = 'connected')
  union all
  select 4, 'reservations cover 151 stay dates',
    (select count(distinct stay_date) from public.reservations
     where hotel_id = (select id from h)) = 151
  union all
  select 5, 'event day near-sellout (day0+13: 29+25+20+5 = 79 booked)',
    (select count(*) from public.reservations
     where hotel_id = (select id from h)
       and stay_date = (select min(stay_date) + 43 from public.reservations
                        where hotel_id = (select id from h))) = 79
  union all
  select 6, '4 rules (1 pickup), 30×4 baseline snapshots',
    (select count(*) from public.pricing_rules where hotel_id = (select id from h)) = 4
    and (select count(*) from public.pricing_rules
         where hotel_id = (select id from h) and is_pickup_rule) = 1
    and (select count(*) from public.stay_date_snapshot
         where hotel_id = (select id from h)) = 120
) checks order by ord;
