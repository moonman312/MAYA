-- ============================================================================
-- 07_supabase_e2e_test_cleanup.sql — full teardown of the E2E fixtures
-- ============================================================================
-- Run in Supabase SQL Editor (service role). Removes the E2E test hotels
-- (05: "MAYA E2E Test Hotel", 08: "… Hotel 2", 09: "… Hotel 3") and every
-- row that references them. Comment out any name you want to keep. Safe to
-- re-run (no-op once gone). The three 03_seed hotels are untouched.
-- ============================================================================

do $$
declare
  v_names text[] := array[
    'MAYA E2E Test Hotel',      -- 05 (Mews-style fixture)
    'MAYA E2E Test Hotel 2',    -- 08 (Think Reservations fixture)
    'MAYA E2E Test Hotel 3'     -- 09 (Cloudbeds fixture)
  ];
  v_name     text;
  v_hotel_id uuid;
begin
  foreach v_name in array v_names loop
    select id into v_hotel_id from public.hotels where name = v_name;
    if v_hotel_id is null then
      raise notice '"%" not found — skipping.', v_name;
      continue;
    end if;

    -- Engine tables WITHOUT a hotels FK (would otherwise be orphaned):
    delete from public.stay_date_snapshot       where hotel_id = v_hotel_id;
    delete from public.published_price          where hotel_id = v_hotel_id;
    delete from public.evaluation_audit         where hotel_id = v_hotel_id;
    delete from public.ladder_transition_event  where hotel_id = v_hotel_id;
    delete from public.pickup_event             where hotel_id = v_hotel_id;

    -- Rules must go BEFORE the hotel: rule_signal_room_type /
    -- rule_affected_room_type reference room_types WITHOUT cascade, so
    -- deleting the hotel (→ room_types) first would violate those FKs.
    -- Deleting the rules cascades rule_condition, signal/affected scope
    -- rows, and ladder_rule_state.
    delete from public.pricing_rules where hotel_id = v_hotel_id;

    -- Everything else cascades from the hotel row: hotel_settings,
    -- room_types, reservations, hotel_memberships, pending_memberships,
    -- pms_connections, audit_events, market_events, competitor_rates…
    delete from public.hotels where id = v_hotel_id;

    raise notice '"%" (%) and all dependent rows deleted.', v_name, v_hotel_id;
  end loop;
end $$;

-- ── Optional: also remove the test auth users ───────────────────────────────
-- Do this from Supabase Dashboard → Authentication → Users (recommended), or
-- uncomment below. Deleting an auth user cascades profiles and any remaining
-- memberships; pending_memberships.accepted_by is ON DELETE SET NULL.
--
-- delete from auth.users where lower(email) in (
--   'scdeloach16+mayatest@gmail.com',
--   'scdeloach16+mayatest2@gmail.com',
--   'scdeloach16+mayatest3@gmail.com'
-- );
