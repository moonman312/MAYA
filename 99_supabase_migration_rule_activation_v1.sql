-- ============================================================================
-- MAYA rule editing and the activation popup (v1)
-- ============================================================================
--
-- Decided by Jake on 2026-09-28 (fix list G25 B, and the popup in his words).
-- Rules can now be edited in the rule builder, and whenever a rule is about
-- to become active (switched on in the rules list, saved new and on, or an
-- edit saved on a rule that is on) the owner sees which nights it will
-- change and chooses:
--
--   * Apply price adjustments: the rule acts on every night it matches now,
--     exactly as the popup showed (the popup's days come from a dry run of
--     the engine itself, src/lib/rule-preview.ts).
--   * Skip price adjustments: the rule is on, but the nights it matches now
--     are left alone. It acts only on what changes from then on, and a
--     booking speed or pickup rule counts bookings from that moment.
--
-- What this file adds:
--
--   1. pricing_rules.skip_at: when the owner last chose Skip, null after
--      Apply. The engine (both copies) reads it with the rule:
--        - a booking speed or pickup rule counts from its own newest change
--          still on the night or skip_at, whichever is later, and its
--          changes already on the price at skip_at stay as they are (an
--          edit does not take them off, cancellations are not checked on
--          them, they still cover the weaker rules);
--        - a standard (occupancy or days before arrival) rule reads the
--          marks below.
--      pricing_rules.version_ranks: per earlier version whose booking speed
--      or pickup changes are still on the price (left there by a Skip, or
--      by an edit to a rule that is off), the priority and condition that
--      ranked the rule then. Such a change ranks as it was made (its own
--      amount, from pickup_event, and that version's priority and
--      condition), so an edit never changes which weaker rules it covers.
--      save_rule keeps it, dropping versions with no change left on.
--   2. ladder_rule_state.skip_state and skip_at: the marks Skip leaves on a
--      standard rule's rows, written by save_rule with the rule:
--        - 'held': on, with no change on the price, where the rule matched
--          at the Skip. It goes off (moving no price) once the rule stops
--          matching; the next time it matches is a change, and it adjusts.
--        - 'kept': a change already on the price where the rule, as saved,
--          did not match at the Skip. It stays at its amount until the rule
--          matches there, then moves to the rule's amount.
--      A mark whose skip_at is not the rule's current one (the owner has
--      applied since) is read the way Apply reads it: a held row as off, a
--      kept change as one from before an edit.
--   3. save_rule(): the rule, its condition and room type lists, whether it
--      is on, its Skip and the marks, in one transaction, checked against
--      the version the popup was worked out on (another tab may have changed
--      the rule since), and the nights the popup found marked to be priced
--      first (pricing_mark_many, reason 'rule'). Until now an edit was five
--      separate writes a running pricing tick could see half of.
--
-- Also, from the same code (no SQL): an edit saved to a rule that is off no
-- longer takes its booking speed and pickup changes off the price at once
-- (pausing freezes a rule's changes; the edit reaches the price when the
-- rule is switched on, through the popup), and an edit applied now takes
-- off a standard rule's changes on room types or nights the rule no longer
-- covers (they used to stay for good).
--
-- Deploy order: 1. run this file; 2. deploy the edge functions (the
-- engine copy in supabase/functions/_shared/engine, through each sync
-- function); 3. deploy the app. The engine must know the Skip before the app
-- can record one: an engine from before this file reads a held mark as a
-- change on the price and counts a skipped rule's whole window, so a Skip
-- saved before the edge functions are deployed would move prices. Code
-- that runs before this file reads no skip columns (no rule was ever
-- skipped) and the popup's Skip answers "This needs a database update
-- first."; Apply still saves.
--
-- Safe to run more than once. No backfill: no rule has been skipped yet.
--
-- Sections:
--   1. Columns
--   2. save_rule
--   3. Checks
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Columns
-- ----------------------------------------------------------------------------

alter table public.pricing_rules
  add column if not exists skip_at timestamptz,
  add column if not exists version_ranks jsonb;

comment on column public.pricing_rules.skip_at is
  'When the owner last switched the rule on (or saved it) with "Skip price '
  'adjustments": the nights it matched then were left alone and it acts only '
  'on what changes after this instant. Null after "Apply price adjustments". '
  'See 99_supabase_migration_rule_activation_v1.sql.';

comment on column public.pricing_rules.version_ranks is
  'Per earlier version with booking speed or pickup changes still on the '
  'price, {"<version>": {"priority": n, "condition": {...}}}: how the rule '
  'ranked then, so those changes keep covering the weaker rules they covered. '
  'Written by save_rule. See 99_supabase_migration_rule_activation_v1.sql.';

alter table public.ladder_rule_state
  add column if not exists skip_state text,
  add column if not exists skip_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'ladder_rule_state_skip_state_chk'
       and conrelid = 'public.ladder_rule_state'::regclass
  ) then
    alter table public.ladder_rule_state
      add constraint ladder_rule_state_skip_state_chk
      check (skip_state is null or skip_state in ('held', 'kept'));
  end if;
end $$;

comment on column public.ladder_rule_state.skip_state is
  'held: on with no change on the price, left alone by the owner''s Skip. '
  'kept: a change left on the price by the Skip, at its amount, until the '
  'rule matches again. Null otherwise. Belongs to the Skip in skip_at.';

-- ----------------------------------------------------------------------------
-- 2. save_rule
-- ----------------------------------------------------------------------------
--
-- p_hotel_id          the rule's hotel
-- p_rule_id           the rule (for a new rule, the id the popup previewed it
--                     under: rule effects are applied in rule id order, so the
--                     saved rule must have the id the preview used)
-- p_is_new            insert rather than update
-- p_expected_version  the version the popup was worked out on; a rule that
--                     moved on since raises 'rule_changed' (40001)
-- p_fields            the rule as the owner saved it, or null to leave its
--                     settings alone (switching it on):
--                       name, priority, start_date, end_date, is_annual,
--                       dow_mask, action_type, action_direction, action_value,
--                       is_pickup_rule, undo_on_cancellation, version (after),
--                       condition (rule_condition's columns), signal and
--                       affected (room type ids), legacy_conditions
--                       ([{metric, operator, numeric_value, text_value}], new
--                       rules only)
-- p_activation        'apply' (on, no Skip), 'skip' (on, skip_at = p_at, the
--                     marks written), 'keep' (on or off as it is: an edit to
--                     a rule that is off, or a new name) or 'off'
-- p_at                the instant of the Skip
-- p_touched           the nights the popup found the rule has a part in:
--                     marked to be priced first
-- p_skip_marks        [{d, rt, w}]: per night and room type, 'held', 'kept',
--                     'version' (made this version's, at its old amount),
--                     'restamp' (this version's, at its amount) or 'off'
--
-- Returns {id, version, is_active, skip_at}.
create or replace function public.save_rule(
  p_hotel_id uuid,
  p_rule_id uuid,
  p_is_new boolean,
  p_expected_version integer,
  p_fields jsonb,
  p_activation text,
  p_at timestamptz,
  p_touched date[],
  p_skip_marks jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rule    public.pricing_rules%rowtype;
  v_version integer;
  v_active  boolean;
  v_skip_at timestamptz;
  v_at      timestamptz := coalesce(p_at, now());
  v_count   integer;
  v_ranks   jsonb;
begin
  if p_hotel_id is null or p_rule_id is null then
    raise exception 'save_rule needs a hotel and a rule' using errcode = '22023';
  end if;
  if (select auth.role()) is distinct from 'service_role'
     and not public.can_manage_hotel(p_hotel_id) then
    raise exception 'Only a Revenue Manager or above can change this.' using errcode = '42501';
  end if;
  if p_activation is null or p_activation not in ('apply', 'skip', 'keep', 'off') then
    raise exception 'save_rule: activation must be apply, skip, keep or off' using errcode = '22023';
  end if;

  if p_is_new then
    if p_fields is null then
      raise exception 'save_rule: a new rule needs its settings' using errcode = '22023';
    end if;
    if exists (select 1 from public.pricing_rules r where r.id = p_rule_id) then
      raise exception 'rule_exists' using errcode = '23505';
    end if;
    v_active := p_activation in ('apply', 'skip');
    v_skip_at := case when p_activation = 'skip' then v_at end;
    v_version := 1;
    insert into public.pricing_rules (
      id, hotel_id, name, priority, is_active, version,
      start_date, end_date, is_annual, dow_mask,
      action_type, action_direction, action_value,
      is_pickup_rule, undo_on_cancellation, skip_at, created_by
    ) values (
      p_rule_id, p_hotel_id, p_fields->>'name', coalesce((p_fields->>'priority')::integer, 100), v_active, 1,
      (p_fields->>'start_date')::date, (p_fields->>'end_date')::date,
      coalesce((p_fields->>'is_annual')::boolean, false), coalesce((p_fields->>'dow_mask')::integer, 127),
      p_fields->>'action_type', p_fields->>'action_direction', (p_fields->>'action_value')::numeric,
      coalesce((p_fields->>'is_pickup_rule')::boolean, false),
      coalesce((p_fields->>'undo_on_cancellation')::boolean, true),
      v_skip_at, auth.uid()
    );
  else
    select * into v_rule
      from public.pricing_rules r
     where r.id = p_rule_id and r.hotel_id = p_hotel_id
       for update;
    if not found then
      raise exception 'rule_not_found' using errcode = 'P0002';
    end if;
    if p_expected_version is not null and v_rule.version <> p_expected_version then
      raise exception 'rule_changed' using errcode = '40001';
    end if;
    v_version := coalesce((p_fields->>'version')::integer, v_rule.version);
    v_active := case p_activation when 'keep' then v_rule.is_active when 'off' then false else true end;
    v_skip_at := case p_activation when 'skip' then v_at when 'apply' then null else v_rule.skip_at end;
    -- How each earlier version with changes still on the price ranked
    -- (see the header): kept for those, and the version this edit replaces
    -- added while it has any. Read before the condition is replaced below.
    v_ranks := v_rule.version_ranks;
    if v_version <> v_rule.version then
      select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) into v_ranks
        from jsonb_each(coalesce(v_rule.version_ranks, '{}'::jsonb)) e
       where e.key ~ '^[0-9]+$'
         and exists (
           select 1 from public.pickup_event pe
            where pe.rule_id = p_rule_id and pe.retired_at is null and pe.rule_version = e.key::integer
         );
      if exists (
        select 1 from public.pickup_event pe
         where pe.rule_id = p_rule_id and pe.retired_at is null and pe.rule_version = v_rule.version
      ) then
        v_ranks := v_ranks || jsonb_build_object(
          v_rule.version::text,
          jsonb_build_object(
            'priority', v_rule.priority,
            'condition', coalesce((
              select jsonb_build_object(
                'occupancy_operator', c.occupancy_operator,
                'dta_operator', c.dta_operator,
                'pickup_operator', c.pickup_operator,
                'pickup_threshold', c.pickup_threshold,
                'pickup_metric', c.pickup_metric,
                'booking_speed_operator', c.booking_speed_operator,
                'booking_speed_level', c.booking_speed_level
              )
                from public.rule_condition c
               where c.rule_id = p_rule_id
               limit 1
            ), '{}'::jsonb)
          )
        );
      end if;
      if v_ranks = '{}'::jsonb then
        v_ranks := null;
      end if;
    end if;
    update public.pricing_rules r
       set name = coalesce(p_fields->>'name', r.name),
           priority = coalesce((p_fields->>'priority')::integer, r.priority),
           start_date = case when p_fields ? 'start_date' then (p_fields->>'start_date')::date else r.start_date end,
           end_date = case when p_fields ? 'end_date' then (p_fields->>'end_date')::date else r.end_date end,
           is_annual = coalesce((p_fields->>'is_annual')::boolean, r.is_annual),
           dow_mask = coalesce((p_fields->>'dow_mask')::integer, r.dow_mask),
           action_type = coalesce(p_fields->>'action_type', r.action_type),
           action_direction = coalesce(p_fields->>'action_direction', r.action_direction),
           action_value = coalesce((p_fields->>'action_value')::numeric, r.action_value),
           is_pickup_rule = coalesce((p_fields->>'is_pickup_rule')::boolean, r.is_pickup_rule),
           undo_on_cancellation = coalesce((p_fields->>'undo_on_cancellation')::boolean, r.undo_on_cancellation),
           version = v_version,
           is_active = v_active,
           skip_at = v_skip_at,
           version_ranks = v_ranks,
           updated_at = now()
     where r.id = p_rule_id;
  end if;

  -- The condition, replaced whole.
  if p_fields ? 'condition' then
    delete from public.rule_condition c where c.rule_id = p_rule_id;
    insert into public.rule_condition
    select (jsonb_populate_record(null::public.rule_condition, p_fields->'condition' || jsonb_build_object('rule_id', p_rule_id))).*;
  end if;

  -- The room types it measures and changes: only this hotel's, never none.
  if p_fields ? 'signal' then
    delete from public.rule_signal_room_type s where s.rule_id = p_rule_id;
    insert into public.rule_signal_room_type (rule_id, room_type_id)
    select distinct p_rule_id, rt.id
      from public.room_types rt
     where rt.hotel_id = p_hotel_id
       and rt.id in (select value::uuid from jsonb_array_elements_text(p_fields->'signal'));
    get diagnostics v_count = row_count;
    if v_count = 0 then
      raise exception 'Pick at least one room type to measure.' using errcode = '22023';
    end if;
  end if;
  if p_fields ? 'affected' then
    delete from public.rule_affected_room_type a where a.rule_id = p_rule_id;
    insert into public.rule_affected_room_type (rule_id, room_type_id)
    select distinct p_rule_id, rt.id
      from public.room_types rt
     where rt.hotel_id = p_hotel_id
       and rt.id in (select value::uuid from jsonb_array_elements_text(p_fields->'affected'));
    get diagnostics v_count = row_count;
    if v_count = 0 then
      raise exception 'Pick at least one room type to change.' using errcode = '22023';
    end if;
  end if;

  -- The older tables a few screens still read, for a new rule, as the
  -- rules store has always written them.
  if p_is_new then
    insert into public.pricing_rule_conditions (rule_id, metric, operator, numeric_value, text_value)
    select p_rule_id, x.metric, x.operator, x.numeric_value, x.text_value
      from jsonb_to_recordset(coalesce(p_fields->'legacy_conditions', '[]'::jsonb))
        as x(metric text, operator text, numeric_value numeric, text_value text);
    insert into public.pricing_rule_room_types (rule_id, room_type_id)
    select a.rule_id, a.room_type_id from public.rule_affected_room_type a where a.rule_id = p_rule_id
    on conflict do nothing;
  end if;

  -- The owner's Skip on a standard rule's rows (see the header).
  if p_activation = 'skip' and p_skip_marks is not null and jsonb_array_length(p_skip_marks) > 0 then
    select * into v_rule from public.pricing_rules r where r.id = p_rule_id;

    insert into public.ladder_rule_state as s (
      rule_id, rule_version, stay_date, room_type_id, is_active, activated_at, deactivated_at,
      suppressed_at, last_evaluated_at, action_kind, action_direction, action_value, skip_state, skip_at
    )
    select p_rule_id, v_version, m.d, m.rt, true, v_at, null, null, v_at,
           v_rule.action_type, v_rule.action_direction, v_rule.action_value, 'held', v_at
      from jsonb_to_recordset(p_skip_marks) as m(d date, rt uuid, w text)
     where m.w = 'held'
    on conflict (rule_id, stay_date, room_type_id) do update
       set rule_version = excluded.rule_version,
           is_active = true,
           activated_at = excluded.activated_at,
           deactivated_at = null,
           suppressed_at = null,
           last_evaluated_at = excluded.last_evaluated_at,
           action_kind = excluded.action_kind,
           action_direction = excluded.action_direction,
           action_value = excluded.action_value,
           skip_state = 'held',
           skip_at = excluded.skip_at;

    update public.ladder_rule_state s
       set skip_state = 'kept', skip_at = v_at, rule_version = v_version
      from jsonb_to_recordset(p_skip_marks) as m(d date, rt uuid, w text)
     where m.w = 'kept' and s.rule_id = p_rule_id and s.stay_date = m.d and s.room_type_id = m.rt and s.is_active;

    update public.ladder_rule_state s
       set rule_version = v_version, skip_state = null, skip_at = null
      from jsonb_to_recordset(p_skip_marks) as m(d date, rt uuid, w text)
     where m.w = 'version' and s.rule_id = p_rule_id and s.stay_date = m.d and s.room_type_id = m.rt and s.is_active;

    update public.ladder_rule_state s
       set rule_version = v_version,
           action_kind = v_rule.action_type,
           action_direction = v_rule.action_direction,
           action_value = v_rule.action_value,
           skip_state = null,
           skip_at = null
      from jsonb_to_recordset(p_skip_marks) as m(d date, rt uuid, w text)
     where m.w = 'restamp' and s.rule_id = p_rule_id and s.stay_date = m.d and s.room_type_id = m.rt and s.is_active;

    update public.ladder_rule_state s
       set is_active = false, deactivated_at = v_at, suppressed_at = null, last_evaluated_at = v_at,
           skip_state = null, skip_at = null
      from jsonb_to_recordset(p_skip_marks) as m(d date, rt uuid, w text)
     where m.w = 'off' and s.rule_id = p_rule_id and s.stay_date = m.d and s.room_type_id = m.rt and s.is_active;
  end if;

  -- The nights the rule has a part in go first on the next pricing tick.
  -- (The rule's own change also asks for a new daily pass, through
  -- trg_pricing_mark_rules_upd and the condition and room type triggers.)
  if p_touched is not null and cardinality(p_touched) > 0 then
    perform public.pricing_mark_many(array_fill(p_hotel_id, array[cardinality(p_touched)]), p_touched, 'rule');
  end if;

  return jsonb_build_object('id', p_rule_id, 'version', v_version, 'is_active', v_active, 'skip_at', v_skip_at);
end;
$$;

revoke all on function public.save_rule(uuid, uuid, boolean, integer, jsonb, text, timestamptz, date[], jsonb)
  from public, anon;
grant execute on function public.save_rule(uuid, uuid, boolean, integer, jsonb, text, timestamptz, date[], jsonb)
  to authenticated, service_role;

comment on function public.save_rule(uuid, uuid, boolean, integer, jsonb, text, timestamptz, date[], jsonb) is
  'Saves a rule, whether it is on, the owner''s Skip and its marks in one '
  'transaction. See 99_supabase_migration_rule_activation_v1.sql.';

-- ----------------------------------------------------------------------------
-- 3. Checks
-- ----------------------------------------------------------------------------

do $$
begin
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'pricing_rules'
         and column_name in ('skip_at', 'version_ranks')) <> 2 then
    raise exception 'rule activation: pricing_rules skip columns are missing';
  end if;
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'ladder_rule_state'
         and column_name in ('skip_state', 'skip_at')) <> 2 then
    raise exception 'rule activation: ladder_rule_state skip columns are missing';
  end if;
  if to_regprocedure('public.save_rule(uuid, uuid, boolean, integer, jsonb, text, timestamptz, date[], jsonb)') is null then
    raise exception 'rule activation: save_rule is missing';
  end if;
end $$;

commit;

-- Verification (run by hand after the file):
--   select count(*) from public.pricing_rules where skip_at is not null;        -- 0 until someone skips
--   select skip_state, count(*) from public.ladder_rule_state group by 1;       -- null only, at first
