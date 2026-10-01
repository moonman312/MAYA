-- ============================================================================
-- MAYA: a rule's fire log behind its fire count, v1
-- ============================================================================
--
-- The rules list shows how often each rule fired ("12×"). Jake, 2026-09-30:
-- the count should open a log of THAT rule's fires, like the change log, and
-- the count and the log must cover the same fires over the same period.
--
-- The count used to cover every fire ever recorded, while everything that
-- explains a fire (the night's price before and after, the numbers the run
-- saw) lives in evaluation_audit, which the engine keeps for 90 days
-- (purgeOldAuditRows, both engine copies). A log longer than that would list
-- fires it cannot explain, and a count longer than the log would not match
-- it. So a fire is now defined once, here, over the same 90 days, and both
-- the count and the log read that one definition:
--
--   1. rule_fires(hotel, rule = null): every fire of the property's rules (or
--      one rule's) in the last 90 days. A fire is
--        - a standard rule's change switched on: a ladder_transition_event
--          'activate' row (one per night and room type), dated
--          transitioned_at; and
--        - a booking speed or pickup rule's raise or cut: a pickup_event row,
--          dated applied_at, except the rows the old same-run bug wrote and
--          took off at once (retired_reason 'self_cancelled'), which never
--          happened.
--      This is exactly what rule_fire_counts counted before
--      (99_supabase_migration_pickup_event_stacking_v1.sql), cut to 90 days.
--      Each fire has a sort key (night, room type, kind, id) that orders the
--      fires of one run, which share an instant, so a page never splits or
--      repeats them. Security invoker: called on its own, RLS decides.
--
--   2. rule_fire_counts(hotel): restated (newest definition, from the
--      stacking migration) as a count of rule_fires per rule. Same signature,
--      same return; the only change is the 90 days.
--
--   3. rule_fire_log(hotel, rule, before_at, before_key, limit): one page of
--      a rule's fires, newest first, older than the cursor (the last fire of
--      the page before: its instant and sort key). For each fire, what the
--      log explains it with:
--        - its adjustment, and the rule version that made it;
--        - the numbers it fired on: a ladder fire's own metrics_snapshot; a
--          pickup fire's metrics from its run's audit row (the 'won'
--          candidate of that rule, at most one per night and room type per
--          run), and the numbers the pickup_event row itself keeps
--          (booked units at the start and end of its count, and the
--          booking speed window's bookings and usual figure) for when that
--          audit row is not there;
--        - the night's price before the run (the night's newest audit row
--          before it) and after it (the run's own audit row), the clamp on
--          the price, and whether a later run wrote the night again
--          (newer_row_at, null when this run's price is still the night's
--          latest);
--        - what ended it later: a ladder fire's next transition on the same
--          night and room type ('deactivate': it came off; 'activate': the
--          rule's new amount replaced it after an edit), a pickup fire's
--          retired_at and retired_reason; a typed price that took over a
--          ladder fire (ladder_rule_state.suppressed_at, while that row is
--          still this fire's); and the owner's "stop" on the night after it
--          (rule_repeat_alert_nights).
--      Security definer with the same check as rule_fire_counts: the service
--      role, or someone the property is accessible to (is_hotel_accessible:
--      its members, and a platform admin viewing it). Developer and Sales
--      logins are neither, unless they are members.
--
-- Nothing is stored and nothing the engine writes changes: every number the
-- log shows was already kept, for a ladder fire on its own row and for a
-- pickup fire on its run's audit row (pickup_candidates[].metrics) and its
-- own columns.
--
-- The app reads the 90 days as FIRE_LOG_DAYS (src/lib/rule-fire-log.ts).
-- The PGlite test runs this file twice (rule-fire-log-migration-sql.test.ts).
-- Run AFTER 99_supabase_migration_simulation_history_v1.sql. One transaction.
-- Idempotent: every function is replaced, nothing else is created.
--
-- Checking by hand afterwards (a property's id in place of the zeros):
--
--   select * from public.rule_fire_counts('00000000-0000-0000-0000-000000000000');
--
-- One row per rule that fired in the last 90 days.
-- ============================================================================

begin;

do $$
begin
  if to_regprocedure('public.rule_fire_counts(uuid)') is null
     or to_regprocedure('public.is_hotel_accessible(uuid)') is null
     or to_regclass('public.rule_repeat_alert_nights') is null
     or to_regclass('public.hotel_mode_history') is null then
    raise exception 'Run every migration before 99_supabase_migration_rule_fire_log_v1.sql first';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'pickup_event' and column_name = 'retired_reason'
  ) or not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'ladder_rule_state' and column_name = 'suppressed_at'
  ) then
    raise exception 'Run 99_supabase_migration_pickup_event_stacking_v1.sql and 99_supabase_migration_manual_price_v1.sql first';
  end if;
end $$;

-- ── 1. What a fire is ──────────────────────────────────────────────────────

create or replace function public.rule_fires(p_hotel_id uuid, p_rule_id uuid default null)
returns table(
  kind text,
  event_id uuid,
  rule_id uuid,
  fired_at timestamptz,
  stay_date date,
  room_type_id uuid,
  sort_key text
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select 'ladder'::text, e.id, e.rule_id, e.transitioned_at, e.stay_date, e.room_type_id,
         e.stay_date::text || '|' || e.room_type_id::text || '|ladder|' || e.id::text
    from public.ladder_transition_event e
   where e.hotel_id = p_hotel_id
     and (p_rule_id is null or e.rule_id = p_rule_id)
     and e.transition = 'activate'
     and e.transitioned_at >= now() - interval '90 days'
  union all
  select 'pickup'::text, p.id, p.rule_id, p.applied_at, p.stay_date, p.affected_room_type_id,
         p.stay_date::text || '|' || p.affected_room_type_id::text || '|pickup|' || p.id::text
    from public.pickup_event p
   where p.hotel_id = p_hotel_id
     and (p_rule_id is null or p.rule_id = p_rule_id)
     and p.retired_reason is distinct from 'self_cancelled'
     and p.applied_at >= now() - interval '90 days'
$$;

comment on function public.rule_fires(uuid, uuid) is
  'Every fire of a property''s rules (or one rule''s) in the last 90 days: ladder activations and pickup events '
  '(not self_cancelled). The one definition rule_fire_counts and rule_fire_log both read. '
  '99_supabase_migration_rule_fire_log_v1.sql';

revoke all on function public.rule_fires(uuid, uuid) from public, anon;
grant execute on function public.rule_fires(uuid, uuid) to authenticated, service_role;

-- ── 2. How many, per rule ──────────────────────────────────────────────────

-- Restated from 99_supabase_migration_pickup_event_stacking_v1.sql (the
-- newest definition): the same check and the same fires, now read from
-- rule_fires, so over the last 90 days.
create or replace function public.rule_fire_counts(p_hotel_id uuid)
returns table(rule_id uuid, fires bigint)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if (select auth.role()) is distinct from 'service_role'
     and not public.is_hotel_accessible(p_hotel_id) then
    raise exception 'Not authorized to read rule history for hotel %', p_hotel_id
      using errcode = '42501';
  end if;

  return query
  select f.rule_id, count(*)::bigint
    from public.rule_fires(p_hotel_id) f
   group by f.rule_id;
end;
$$;

revoke all on function public.rule_fire_counts(uuid) from public, anon;
grant execute on function public.rule_fire_counts(uuid) to authenticated, service_role;

-- ── 3. One rule's fires, a page at a time ──────────────────────────────────

-- A redefinition with other columns than an earlier run of this file would
-- be refused by create or replace; there is no earlier version, so a re-run
-- replaces it in place.
create or replace function public.rule_fire_log(
  p_hotel_id uuid,
  p_rule_id uuid,
  p_before_at timestamptz default null,
  p_before_key text default null,
  p_limit integer default 25
)
returns table(
  kind text,
  event_id uuid,
  sort_key text,
  fired_at timestamptz,
  stay_date date,
  room_type_id uuid,
  rule_version integer,
  action_kind text,
  action_direction text,
  action_value numeric,
  fire_seq integer,
  metrics jsonb,
  own_numbers jsonb,
  price_before numeric,
  price_after numeric,
  clamped_by text,
  newer_row_at timestamptz,
  ended_at timestamptz,
  ended_reason text,
  suppressed_at timestamptz,
  stopped_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  if (select auth.role()) is distinct from 'service_role'
     and not public.is_hotel_accessible(p_hotel_id) then
    raise exception 'Not authorized to read rule history for hotel %', p_hotel_id
      using errcode = '42501';
  end if;

  return query
  with page as (
    select f.kind, f.event_id, f.fired_at, f.stay_date, f.room_type_id, f.sort_key
      from public.rule_fires(p_hotel_id, p_rule_id) f
     where p_before_at is null
        or f.fired_at < p_before_at
        or (f.fired_at = p_before_at and f.sort_key > coalesce(p_before_key, ''))
     order by f.fired_at desc, f.sort_key asc
     limit greatest(1, least(coalesce(p_limit, 25), 101))
  )
  select
    pg.kind,
    pg.event_id,
    pg.sort_key,
    pg.fired_at,
    pg.stay_date,
    pg.room_type_id,
    coalesce(le.rule_version, pe.rule_version),
    coalesce(le.action_kind, pe.action_kind),
    coalesce(le.action_direction, pe.action_direction),
    coalesce(le.action_value, pe.action_value),
    pe.fire_seq,
    case
      when pg.kind = 'ladder' then le.metrics_snapshot
      else jsonb_path_query_first(
             au.details,
             '$.pickup_candidates[*] ? (@.rule_id == $r && @.outcome == "won")',
             jsonb_build_object('r', p_rule_id::text)
           ) -> 'metrics'
    end,
    case
      when pg.kind = 'pickup' then jsonb_build_object(
        'units_start', pe.signal_booked_units_start,
        'units_end', pe.signal_booked_units_end,
        'window_bookings', pe.window_bookings_at_fire,
        'window_expected', pe.window_expected_at_fire
      )
    end,
    bf.final_price,
    au.final_price,
    au.details ->> 'clamped_by',
    nw.evaluated_at,
    case when pg.kind = 'ladder' then nx.transitioned_at else pe.retired_at end,
    case
      when pg.kind = 'ladder' then
        case nx.transition when 'deactivate' then 'came_off' when 'activate' then 'replaced' end
      else pe.retired_reason
    end,
    st.suppressed_at,
    (select min(r.chosen_at)
       from public.rule_repeat_alert_nights r
      where r.rule_id = p_rule_id
        and r.hotel_id = p_hotel_id
        and r.stay_date = pg.stay_date
        and r.choice = 'stop'
        and r.chosen_at > pg.fired_at)
  from page pg
  left join public.ladder_transition_event le
    on pg.kind = 'ladder' and le.id = pg.event_id
  left join public.pickup_event pe
    on pg.kind = 'pickup' and pe.id = pg.event_id
  -- The run's own row for the night, and the night's rows either side of it.
  left join lateral (
    select a.final_price, a.details
      from public.evaluation_audit a
     where a.hotel_id = p_hotel_id
       and a.stay_date = pg.stay_date
       and a.room_type_id = pg.room_type_id
       and a.evaluated_at = pg.fired_at
     limit 1
  ) au on true
  left join lateral (
    select b.final_price
      from public.evaluation_audit b
     where b.hotel_id = p_hotel_id
       and b.stay_date = pg.stay_date
       and b.room_type_id = pg.room_type_id
       and b.evaluated_at < pg.fired_at
     order by b.evaluated_at desc
     limit 1
  ) bf on true
  left join lateral (
    select n.evaluated_at
      from public.evaluation_audit n
     where n.hotel_id = p_hotel_id
       and n.stay_date = pg.stay_date
       and n.room_type_id = pg.room_type_id
       and n.evaluated_at > pg.fired_at
     order by n.evaluated_at asc
     limit 1
  ) nw on true
  -- A ladder fire's next transition on its night and room type.
  left join lateral (
    select x.transition, x.transitioned_at
      from public.ladder_transition_event x
     where pg.kind = 'ladder'
       and x.rule_id = p_rule_id
       and x.stay_date = pg.stay_date
       and x.room_type_id = pg.room_type_id
       and x.hotel_id = p_hotel_id
       and x.transitioned_at > pg.fired_at
     order by x.transitioned_at asc
     limit 1
  ) nx on true
  -- A typed price that took over this ladder fire, while the row is still its.
  left join lateral (
    select s.suppressed_at
      from public.ladder_rule_state s
     where pg.kind = 'ladder'
       and s.rule_id = p_rule_id
       and s.stay_date = pg.stay_date
       and s.room_type_id = pg.room_type_id
       and s.activated_at = pg.fired_at
       and s.suppressed_at is not null
     limit 1
  ) st on true
  order by pg.fired_at desc, pg.sort_key asc;
end;
$$;

comment on function public.rule_fire_log(uuid, uuid, timestamptz, text, integer) is
  'One page of a rule''s fires (rule_fires), newest first, older than (p_before_at, p_before_key), with the '
  'prices, numbers and later endings the rules list''s fire log shows. 99_supabase_migration_rule_fire_log_v1.sql';

revoke all on function public.rule_fire_log(uuid, uuid, timestamptz, text, integer) from public, anon;
grant execute on function public.rule_fire_log(uuid, uuid, timestamptz, text, integer) to authenticated, service_role;

commit;
