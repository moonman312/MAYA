-- MAYA dev reset: clear app data and/or drop tables for a clean rebuild.
-- Run in Supabase SQL Editor (or psql) as a role that can truncate/drop in public.
--
-- Schema drift: before merge 29a5d6f (PR #1 / 040526-db-updates), the model still had
-- organizations + organization_memberships and hotels.organization_id, and did not yet
-- include engine tables (stay_date_snapshot, rule_condition, ladder_*, pickup_event,
-- published_price, evaluation_audit). This script unions both eras so it works whether
-- your database is pre-merge, post-merge, or partially migrated.
--
-- Does NOT delete auth.users. Clearing profiles removes public profile rows only.
--
-- HOW TO USE:
--   • Data only: uncomment SECTION A, run once, leave B commented.
--   • Full structural reset: uncomment SECTION B, run once, then apply 02_supabase_schema.sql.
--
-- ---------------------------------------------------------------------------
-- SECTION A — CLEAR DATA ONLY (truncates tables that actually exist)
-- ---------------------------------------------------------------------------

/*
do $$
declare
  want text[] := array[
    'audit_events',
    'competitor_rates',
    'evaluation_audit',
    'hotel_memberships',
    'hotel_settings',
    'hotels',
    'ladder_rule_state',
    'ladder_transition_event',
    'market_events',
    'occupancy_metrics',
    'organization_memberships',
    'organizations',
    'pickup_event',
    'pricing_decisions',
    'pricing_rule_conditions',
    'pricing_rule_room_types',
    'pricing_rules',
    'profiles',
    'published_price',
    'pms_connection_secrets',
    'pms_connections',
    'rate_updates',
    'reservations',
    'room_constraints',
    'room_types',
    'rule_applications',
    'rule_affected_room_type',
    'rule_condition',
    'rule_signal_room_type',
    'stay_date_snapshot'
  ];
  t text;
  found text[] := array[]::text[];
begin
  foreach t in array want
  loop
    if exists (
      select 1
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind = 'r'
        and c.relname = t
    ) then
      found := array_append(found, format('%I', t));
    end if;
  end loop;

  if cardinality(found) > 0 then
    execute format(
      'truncate table %s restart identity cascade',
      array_to_string(found, ', ')
    );
    raise notice 'Truncated % table(s).', cardinality(found);
  else
    raise notice 'No MAYA tables found in public — nothing to truncate.';
  end if;
end $$;
*/

-- ---------------------------------------------------------------------------
-- SECTION B — DROP TABLES + ENUMS (then re-run 02_supabase_schema.sql)
-- ---------------------------------------------------------------------------
-- DROP TABLE IF EXISTS skips missing names; CASCADE tears down FKs between listed tables.

/*
drop table if exists
  audit_events,
  competitor_rates,
  evaluation_audit,
  hotel_memberships,
  hotel_settings,
  hotels,
  ladder_rule_state,
  ladder_transition_event,
  market_events,
  occupancy_metrics,
  organization_memberships,
  organizations,
  pickup_event,
  pricing_decisions,
  pricing_rule_conditions,
  pricing_rule_room_types,
  pricing_rules,
  profiles,
  published_price,
  pms_connection_secrets,
  pms_connections,
  rate_updates,
  reservations,
  room_constraints,
  room_types,
  rule_applications,
  rule_affected_room_type,
  rule_condition,
  rule_signal_room_type,
  stay_date_snapshot
cascade;

drop type if exists rate_update_status cascade;
drop type if exists run_status cascade;
drop type if exists run_type cascade;
drop type if exists connection_status cascade;
drop type if exists pms_type cascade;
drop type if exists membership_status cascade;
drop type if exists hotel_membership_role cascade;
-- Pre–PR #1 enums (safe no-ops if already removed)
drop type if exists organization_membership_role cascade;
drop type if exists scope_type cascade;
drop type if exists rule_metric cascade;
drop type if exists rule_operator cascade;
drop type if exists action_type cascade;
drop type if exists action_direction cascade;
*/
