-- MAYA Booking Speed Rules v1 Migration
--
-- Adds Booking Speed as a fourth rule-condition family. Rules can now say
-- "booking speed over the past month is at least Much Slower Than Normal"
-- via three columns (operator/level/window) plus an optional per-rule
-- cooldown that throttles re-fires on the same stay date. The level
-- vocabulary matches the Observation Engine's seven ordered speeds.
--
-- Run AFTER 02_supabase_schema.sql. Safe to re-run (add column if not
-- exists + named constraints dropped and re-added). Also folded into
-- 02_supabase_schema.sql.

alter table rule_condition
  add column if not exists booking_speed_operator text,
  add column if not exists booking_speed_level text,
  add column if not exists booking_speed_window_days integer,
  add column if not exists booking_speed_cooldown_days integer;

alter table rule_condition drop constraint if exists rule_condition_bs_operator_chk;
alter table rule_condition add constraint rule_condition_bs_operator_chk
  check (booking_speed_operator is null or booking_speed_operator in ('at_least','at_most','is'));

alter table rule_condition drop constraint if exists rule_condition_bs_level_chk;
alter table rule_condition add constraint rule_condition_bs_level_chk
  check (booking_speed_level is null or booking_speed_level in
    ('stalled','much_slower','slower','normal','faster','much_faster','surging'));

alter table rule_condition drop constraint if exists rule_condition_bs_window_chk;
alter table rule_condition add constraint rule_condition_bs_window_chk
  check (booking_speed_window_days is null or booking_speed_window_days in (1, 7, 30));

alter table rule_condition drop constraint if exists rule_condition_bs_cooldown_chk;
alter table rule_condition add constraint rule_condition_bs_cooldown_chk
  check (booking_speed_cooldown_days is null or booking_speed_cooldown_days >= 0);

-- Operator, level, and window travel together; cooldown is optional and
-- only meaningful when the family is present.
alter table rule_condition drop constraint if exists rule_condition_bs_all_or_nothing_chk;
alter table rule_condition add constraint rule_condition_bs_all_or_nothing_chk
  check (
    (booking_speed_operator is null and booking_speed_level is null
     and booking_speed_window_days is null and booking_speed_cooldown_days is null)
    or
    (booking_speed_operator is not null and booking_speed_level is not null
     and booking_speed_window_days is not null)
  );

-- Replace the "at least one condition family" check so a rule may be built
-- on booking speed alone. The original constraint was anonymous, so it is
-- located by its definition (only that check mentions occupancy_operator in
-- an OR chain) rather than by a guessed auto-generated name. Idempotent:
-- re-running drops and re-adds the named replacement.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'rule_condition'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%occupancy_operator IS NOT NULL%'
  loop
    execute format('alter table rule_condition drop constraint %I', c.conname);
  end loop;
end $$;

alter table rule_condition add constraint rule_condition_at_least_one_family_chk
  check (
    occupancy_operator is not null
    or dta_operator is not null
    or pickup_operator is not null
    or booking_speed_operator is not null
  );
