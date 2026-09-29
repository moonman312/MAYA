-- ============================================================================
-- MAYA rule editing and the activation popup (v1)
-- ============================================================================
--
-- Decided by Jake on 2026-09-28 (fix list G25 B, and the popup in his words),
-- with his answers of 2026-09-29 on Skip. Rules can now be edited in the
-- rule builder, and whenever a rule is about to become active (switched on
-- in the rules list, saved new and on, or an edit saved on a rule that is
-- on) the owner sees which days it will change and chooses:
--
--   * Apply price adjustments: the rule acts on every night it matches now,
--     exactly as the popup showed (the popup's days come from a dry run of
--     the engine itself, src/lib/rule-preview.ts).
--   * Skip price adjustments: the rule is on, and the days the popup showed
--     keep their prices. On each of those days the rule's part in the price
--     is held as it is until the rule stops being true there and then
--     becomes true again; from then on it acts there as on any other day.
--     Every other day works exactly as if the owner had chosen Apply. A
--     Skip never moves where a booking speed or pickup rule counts from:
--     the bookings made before the rule existed always count.
--   * When the popup shows no days, one button turns the rule on (Apply,
--     which then changes nothing). When the days could not be worked out,
--     Skip holds every day the rule could act on.
--
-- What this file adds:
--
--   1. pricing_rules.skip_at: when the owner last chose Skip, null after
--      Apply. It names the Skip the holds below belong to: a hold of an older
--      Skip (the owner applied, or skipped again, since) is not a hold.
--      pricing_rules.version_ranks: per earlier version whose booking speed
--      or pickup changes are still on the price (held by a Skip, or left by
--      an edit to a rule that is off), the priority, amount and condition
--      that ranked the rule then. Such a change ranks as it was made (its own
--      amount, from pickup_event, and that version's priority and
--      condition), so an edit never changes which weaker rules it covers.
--      save_rule keeps it, dropping versions with no change left on.
--   2. ladder_rule_state.skip_state and skip_at: a standard (occupancy or
--      days before arrival) rule's holds, on its rows, written by save_rule
--      on the days the popup showed:
--        - 'held': on, with no change on the price, where the rule was about
--          to adjust. It goes off (moving no price) once the rule stops
--          holding; the next time the rule holds is a change, and it adjusts.
--        - 'carried': a change already on the price, at its amount, where
--          the rule was about to move it to its new amount (an edit). It
--          stays once the rule stops holding (it becomes 'kept').
--        - 'kept': a change already on the price, at its amount, where the
--          rule was about to take it off. It stays until the rule is true
--          there again, and then moves to the rule's amount.
--      A mark whose skip_at is not the rule's current one is read the way
--      Apply reads it: a held row as off, a kept or carried change as one
--      from before an edit.
--   3. rule_skip_hold: a booking speed or pickup rule's holds, one per day
--      and room type the popup showed (the room types the rule changes, and
--      any with a change of it on the price), with the Skip they belong to
--      and what the engine last found (was_true: null until it has judged
--      the rule there, then whether the rule was true). While a day is
--      held the rule makes no change there, and its changes on the price
--      there stay as they are: an edit does not take them off and
--      cancellations are not checked on them. The engine ends the hold the
--      first time it finds the rule true after finding it not true, and the
--      rule acts there in that same run. A standard rule's older booking
--      speed or pickup changes (an edit changed its kind) are held here too.
--   4. save_rule(): the rule, its condition and room type lists, whether it
--      is on, its Skip and holds, in one transaction, checked against the
--      version the popup was worked out on (another tab may have changed the
--      rule since), and the nights the popup found marked to be priced first
--      (pricing_mark_many, reason 'rule'). Until now an edit was five
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
-- function); 3. deploy the app. The engine must know the holds before the
-- app can record one: an engine from before this file reads a held mark as a
-- change on the price and does not read rule_skip_hold, so a Skip saved
-- before the edge functions are deployed would move prices. Code that runs
-- before this file reads no Skip columns and no holds (no rule was ever
-- skipped) and the popup's Skip answers "This needs a database update
-- first."; Apply still saves.
--
-- Safe to run more than once. No backfill: no rule has been skipped yet.
--
-- Sections:
--   1. Columns
--   2. rule_skip_hold
--   3. save_rule
--   4. Checks
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
  'adjustments": the Skip its holds belong to (ladder_rule_state.skip_state, '
  'rule_skip_hold). Null after "Apply price adjustments". '
  'See 99_supabase_migration_rule_activation_v1.sql.';

comment on column public.pricing_rules.version_ranks is
  'Per earlier version with booking speed or pickup changes still on the '
  'price, {"<version>": {"priority", "action_type", "action_direction", '
  '"action_value", "condition"}}: how the rule '
  'ranked then, so those changes keep covering the weaker rules they covered. '
  'Written by save_rule. See 99_supabase_migration_rule_activation_v1.sql.';

alter table public.ladder_rule_state
  add column if not exists skip_state text,
  add column if not exists skip_at timestamptz;

-- Dropped and made again, so a database that ran an earlier draft of this
-- file gets the 'carried' state too.
alter table public.ladder_rule_state drop constraint if exists ladder_rule_state_skip_state_chk;
alter table public.ladder_rule_state
  add constraint ladder_rule_state_skip_state_chk
  check (skip_state is null or skip_state in ('held', 'kept', 'carried'));

comment on column public.ladder_rule_state.skip_state is
  'The owner''s Skip holding this row as it is (see '
  '99_supabase_migration_rule_activation_v1.sql). held: on with no change on '
  'the price, until the rule stops holding. carried: a change left on the '
  'price at its amount, until the rule stops holding (then kept). kept: a '
  'change left on the price at its amount, until the rule is true again. Null '
  'otherwise. Belongs to the Skip in skip_at.';

-- ----------------------------------------------------------------------------
-- 2. rule_skip_hold
-- ----------------------------------------------------------------------------

create table if not exists public.rule_skip_hold (
  rule_id      uuid not null references public.pricing_rules(id) on delete cascade,
  stay_date    date not null,
  room_type_id uuid not null,
  skip_at      timestamptz not null,
  was_true     boolean,
  primary key (rule_id, stay_date, room_type_id)
);

comment on table public.rule_skip_hold is
  'Days a booking speed or pickup rule leaves as they are after the owner''s '
  'Skip, per room type, until the rule stops being true there and then becomes '
  'true again. Written by save_rule, read and ended by the engine. See '
  '99_supabase_migration_rule_activation_v1.sql.';
comment on column public.rule_skip_hold.skip_at is
  'The Skip this hold belongs to: it holds only while it equals the rule''s skip_at.';
comment on column public.rule_skip_hold.was_true is
  'Null until the engine has judged the rule here; then whether the rule was '
  'true the last time. The hold ends when the rule is true after being not true.';

alter table public.rule_skip_hold enable row level security;
revoke all on table public.rule_skip_hold from public, anon, authenticated;
grant select, insert, update, delete on table public.rule_skip_hold to service_role;

-- ----------------------------------------------------------------------------
-- 3. save_rule
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
-- p_activation        'apply' (on, no Skip, no holds), 'skip' (on, skip_at =
--                     p_at, the holds written), 'keep' (on or off as it is:
--                     an edit to a rule that is off, or a new name) or 'off'
-- p_at                the instant of the Skip
-- p_touched           the nights the popup found the rule has a part in:
--                     marked to be priced first
-- p_skip_marks        a standard rule's holds on its rows, [{d, rt, w}], w
--                     'held', 'carried' or 'kept' (see the header)
-- p_hold_nights       the days the Skip holds (the popup's days): a booking
--                     speed or pickup rule is held there on every room type
--                     it changes and every one with a change of it on the
--                     price; any rule's booking speed or pickup changes on
--                     them are held (rule_skip_hold)
--
-- Returns {id, version, is_active, skip_at}.

-- An earlier draft of this file had no p_hold_nights.
drop function if exists public.save_rule(uuid, uuid, boolean, integer, jsonb, text, timestamptz, date[], jsonb);

create or replace function public.save_rule(
  p_hotel_id uuid,
  p_rule_id uuid,
  p_is_new boolean,
  p_expected_version integer,
  p_fields jsonb,
  p_activation text,
  p_at timestamptz,
  p_touched date[],
  p_skip_marks jsonb,
  p_hold_nights date[]
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
            'action_type', v_rule.action_type,
            'action_direction', v_rule.action_direction,
            'action_value', v_rule.action_value,
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

  -- Apply or Skip replaces the holds of any earlier Skip.
  if p_activation in ('apply', 'skip') then
    delete from public.rule_skip_hold h where h.rule_id = p_rule_id;
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

    -- A change left on at its amount: the row keeps its adjustment.
    update public.ladder_rule_state s
       set skip_state = m.w, skip_at = v_at, rule_version = v_version
      from jsonb_to_recordset(p_skip_marks) as m(d date, rt uuid, w text)
     where m.w in ('kept', 'carried')
       and s.rule_id = p_rule_id and s.stay_date = m.d and s.room_type_id = m.rt and s.is_active;
  end if;

  -- The days the Skip holds for booking speed and pickup (see the header):
  -- a booking speed or pickup rule on every room type it changes, and any
  -- rule wherever it has such a change on the price.
  if p_activation = 'skip' and p_hold_nights is not null and cardinality(p_hold_nights) > 0 then
    select * into v_rule from public.pricing_rules r where r.id = p_rule_id;
    insert into public.rule_skip_hold (rule_id, stay_date, room_type_id, skip_at, was_true)
    select distinct p_rule_id, c.stay_date, c.room_type_id, v_at, null::boolean
      from (
        select n.d as stay_date, a.room_type_id
          from unnest(p_hold_nights) as n(d)
          cross join public.rule_affected_room_type a
         where v_rule.is_pickup_rule and a.rule_id = p_rule_id
        union
        select pe.stay_date, pe.affected_room_type_id
          from public.pickup_event pe
         where pe.rule_id = p_rule_id and pe.retired_at is null
           and pe.stay_date = any (p_hold_nights)
        union
        select l.stay_date, l.room_type_id
          from public.ladder_rule_state l
         where v_rule.is_pickup_rule and l.rule_id = p_rule_id and l.is_active
           and l.stay_date = any (p_hold_nights)
      ) c
    on conflict (rule_id, stay_date, room_type_id) do update
       set skip_at = excluded.skip_at, was_true = null;
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

revoke all on function public.save_rule(uuid, uuid, boolean, integer, jsonb, text, timestamptz, date[], jsonb, date[])
  from public, anon;
grant execute on function public.save_rule(uuid, uuid, boolean, integer, jsonb, text, timestamptz, date[], jsonb, date[])
  to authenticated, service_role;

comment on function public.save_rule(uuid, uuid, boolean, integer, jsonb, text, timestamptz, date[], jsonb, date[]) is
  'Saves a rule, whether it is on, the owner''s Skip and its holds in one '
  'transaction. See 99_supabase_migration_rule_activation_v1.sql.';

-- ----------------------------------------------------------------------------
-- 4. Checks
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
  if to_regclass('public.rule_skip_hold') is null then
    raise exception 'rule activation: rule_skip_hold is missing';
  end if;
  if to_regprocedure('public.save_rule(uuid, uuid, boolean, integer, jsonb, text, timestamptz, date[], jsonb, date[])') is null then
    raise exception 'rule activation: save_rule is missing';
  end if;
end $$;

commit;

-- Verification (run by hand after the file):
--   select count(*) from public.pricing_rules where skip_at is not null;        -- 0 until someone skips
--   select skip_state, count(*) from public.ladder_rule_state group by 1;       -- null only, at first
--   select count(*) from public.rule_skip_hold;                                 -- 0 until someone skips
