-- ============================================================================
-- NO CUSTOMER-SIDE DELETION OF PROPERTY DATA
-- ============================================================================
--
-- Deleting a property's data is an administrative action. Nobody signed in to
-- MAYA as a customer should be able to erase it, whatever their role, and not
-- only from a button: the browser talks to PostgREST directly with the
-- customer's own session, so RLS is the only thing standing between a
-- determined user and a DELETE request.
--
-- Two doors were still open.
--
-- 1. hotels. hotels_rls_paywall_v1 let a Hotel Admin delete their own property
--    whenever it had no live subscription. Twenty-six tables cascade from that
--    row, so one request before payment, or after cancelling, took the rules,
--    guardrails, closed periods, history and audit trail with it. That is the
--    exact property the retention policy keeps in order to win it back.
--    Platform admins keep the ability; the purge tooling runs as service role.
--
-- 2. Everything the app only ever deletes on the server. rls_hardening_v1 split
--    the `for all` policies per command and gave DELETE to can_manage_hotel, so
--    a Revenue Manager can still delete reservations, room types, published
--    prices or the change-log history row by row. None of those are deleted
--    through a user session anywhere in the app: the sync, the engine's purges
--    in scheduled runs, and the onboarding analysis all use the service role,
--    which bypasses RLS.
--
-- The delete POLICY is dropped rather than the table privilege revoked, on
-- purpose. /api/evaluate runs the engine under the caller's own session, and its
-- purgeOldSnapshots / purgeOldAuditRows / purgeOldRunLogRows throw on an error.
-- A revoked privilege is an error; an absent policy is a delete that matches no
-- rows. Old rows are still purged by the scheduled runs.
--
-- Deliberately left deletable, because they are product features a customer
-- uses: pricing rules and their conditions and room-type links, ladder state and
-- pickup events (removing a rule undoes its effects), assumption challenges
-- (undoing a correction), and team memberships (removing a teammate, already
-- gated by rank and done through the service role).
--
-- Run after rls_hardening_v1, roles_v2_part2, run_heartbeat_v1 and
-- hotels_rls_paywall_v1. Idempotent. No application deploy is needed.

begin;

drop policy if exists hotels_delete on hotels;
create policy hotels_delete
  on hotels for delete
  using (is_platform_admin());

do $$
declare
  t text;
begin
  foreach t in array array[
    'reservations',
    'room_types',
    'room_constraints',
    'occupancy_metrics',
    'rule_applications',
    'pricing_runs',
    'pricing_decisions',
    'rate_updates',
    'audit_events',
    'market_events',
    'competitor_rates',
    'stay_date_snapshot',
    'published_price',
    'ladder_transition_event',
    'evaluation_audit',
    'evaluation_run_log',
    'onboarding_states',
    'onboarding_findings',
    'hotel_closed_periods',
    'hotel_settings',
    'pms_connections'
  ]
  loop
    if to_regclass('public.' || t) is null then
      continue;
    end if;
    execute format('drop policy if exists %I on public.%I', t || '_delete', t);
  end loop;
end $$;

commit;

-- Check afterwards. Every row should show only select/insert/update for these
-- tables, and hotels_delete should read is_platform_admin():
--
--   select tablename, policyname, cmd, qual
--     from pg_policies
--    where schemaname = 'public'
--      and (cmd = 'DELETE' or tablename = 'hotels')
--    order by tablename, policyname;
