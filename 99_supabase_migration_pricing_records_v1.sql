-- ============================================================================
-- MAYA: pricing records, v1 (audits A24, A28, A29, A31)
-- ============================================================================
--
-- 1. A RULE'S ROOM TYPES ARE ITS HOTEL'S OWN (A24). rule_signal_room_type and
--    rule_affected_room_type took any room type id. The app only offers the
--    hotel's own, but a manager could write a row naming another hotel's room
--    type straight through the database's API, and the engine then wrote that
--    rule's changes on the other hotel's room type, which its own run priced
--    with. The engine now leaves such a room type out and reads only its own
--    hotel's rules' changes; this refuses the row. A trigger on each list
--    checks the room type's hotel against the rule's, and one on pricing_rules
--    refuses moving a rule to another hotel while it lists room types. Rows
--    already there are left alone (the engine ignores them): the check query
--    in the steps finds any.
--
-- 2. THE 90-DAY AUDIT CLEAN-UP KEEPS EACH NIGHT'S NEWEST ROW (A31). A night's
--    evaluation_audit row is written only when its price or reasons change, so
--    on a night nothing moved for 90 days the newest row is the only record of
--    its price. Deleting it made the next run write the night again as a
--    change nobody made (hundreds of nights at once, every 90 days) and left
--    the night with nothing to explain it until then. engine_audit_purge(hotel,
--    days) deletes a row older than the window only when a newer row stands
--    for its night and room type, or its night has passed (before yesterday in
--    UTC, so before today everywhere). The engine calls it after every run
--    (purgeOldAuditRows, both copies); the nightly sweep below follows the same
--    rule. Security invoker, service role only.
--
-- 3. A SEND LOG AND A BUILD STAMP (A29). rate_updates keeps one row per night
--    and room type, so a send replaced by a later one left no trace: the
--    request log has no amounts and is kept 7 days.
--      - rate_send_log: one row for every write to a rate_updates row that
--        changes what it says about a send (price, status, the price left in
--        the PMS, job, rate, error, tries, when sent, confirmed or edited in
--        the PMS), written by a trigger on rate_updates, so no writer can skip
--        it. Each row keeps the price and status it replaced. Only ever added
--        to: an update is refused, a delete is refused until the row is 13
--        months old, and only the sweep below removes those. Members read
--        their hotel's rows, as they read rate_updates; nobody writes.
--      - rate_updates.push_run_id and .build: the push run that wrote the row
--        and the build it ran. The log copies them when the write set them (a
--        push), and leaves them empty for a write that was not a push (a job
--        confirmed later, a rate the hotel changed in the PMS).
--      - evaluation_run_log.build: the build of every pricing run.
--    A build reads "edge@<commit>" for a function deployed with
--    scripts/deploy-function.mjs, "app@<commit>" for the app on Vercel, and
--    "@dev" otherwise (buildStamp in _shared/engine/build.ts).
--
-- 4. THE NIGHTLY SWEEP. engine_data_sweep and engine_data_sweep_proc are
--    restated from their newest definitions (engine_data_sweep_v1 and
--    large_property_scale_v1), same signatures and grants. The audit loop
--    keeps each night's newest row as above, and a fourth loop removes send
--    log rows older than 13 months. Snapshots and the run log are unchanged.
--
-- 5. PILOT HEALTH (A28, A29). platform_pilot_health restated from its newest
--    definition (signups_feed_v1) with three more columns: maya_holds and
--    maya_holds_since (room-nights held by a guardrail that should never fire,
--    and since when; the page counts them as a problem after 30 minutes, when
--    the alert goes out as critical too), and last_run_build. The return type
--    changes, so it is dropped and created again with its grants.
--
-- Run AFTER 99_supabase_migration_sync_claim_paying_only_v1.sql. Idempotent,
-- one transaction. Deploy order: either. Before this file the engine purges
-- only the old audit rows of nights that have passed, the push and the run
-- log write without the new columns, and Pilot health says nothing of holds.
--
-- NOT mirrored into 02_supabase_schema.sql yet: fold it in on the next schema
-- consolidation pass.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. A rule's room types are its hotel's own (A24)
-- ----------------------------------------------------------------------------

create or replace function public.rule_room_type_same_hotel()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rule_hotel uuid;
  v_type_hotel uuid;
begin
  select r.hotel_id into v_rule_hotel from public.pricing_rules r where r.id = new.rule_id;
  select t.hotel_id into v_type_hotel from public.room_types t where t.id = new.room_type_id;
  if v_rule_hotel is distinct from v_type_hotel then
    raise exception 'A rule can only name room types of its own property.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.rule_room_type_same_hotel() from public, anon, authenticated;

drop trigger if exists trg_rule_signal_room_type_same_hotel on public.rule_signal_room_type;
create trigger trg_rule_signal_room_type_same_hotel
  before insert or update on public.rule_signal_room_type
  for each row execute function public.rule_room_type_same_hotel();

drop trigger if exists trg_rule_affected_room_type_same_hotel on public.rule_affected_room_type;
create trigger trg_rule_affected_room_type_same_hotel
  before insert or update on public.rule_affected_room_type
  for each row execute function public.rule_room_type_same_hotel();

create or replace function public.pricing_rule_stays_with_its_room_types()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1 from public.rule_signal_room_type s
      join public.room_types t on t.id = s.room_type_id
     where s.rule_id = new.id and t.hotel_id is distinct from new.hotel_id
    union all
    select 1 from public.rule_affected_room_type a
      join public.room_types t on t.id = a.room_type_id
     where a.rule_id = new.id and t.hotel_id is distinct from new.hotel_id
  ) then
    raise exception 'A rule can only name room types of its own property.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.pricing_rule_stays_with_its_room_types() from public, anon, authenticated;

drop trigger if exists trg_pricing_rules_room_types_same_hotel on public.pricing_rules;
create trigger trg_pricing_rules_room_types_same_hotel
  before update of hotel_id on public.pricing_rules
  for each row
  when (new.hotel_id is distinct from old.hotel_id)
  execute function public.pricing_rule_stays_with_its_room_types();

-- ----------------------------------------------------------------------------
-- 2. The audit clean-up keeps each night's newest row (A31)
-- ----------------------------------------------------------------------------

create or replace function public.engine_audit_purge(
  p_hotel_id uuid,
  p_days integer default 90
)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_removed integer;
begin
  delete from public.evaluation_audit a
   where a.hotel_id = p_hotel_id
     and a.evaluated_at < now() - make_interval(days => greatest(coalesce(p_days, 90), 1))
     and (
       -- The night has passed everywhere.
       a.stay_date < (now() at time zone 'utc')::date - 1
       -- A newer row stands for the night: the order the engine reads its
       -- newest row in (loadPriorAuditSignatures: evaluated_at, then id).
       or exists (
         select 1
           from public.evaluation_audit b
          where b.hotel_id = a.hotel_id
            and b.stay_date = a.stay_date
            and b.room_type_id = a.room_type_id
            and (b.evaluated_at > a.evaluated_at or (b.evaluated_at = a.evaluated_at and b.id > a.id))
       )
     );
  get diagnostics v_removed = row_count;
  return v_removed;
end;
$$;

comment on function public.engine_audit_purge(uuid, integer) is
  'Deletes a property''s evaluation_audit rows older than p_days (90), except a night''s newest row while '
  'the night is still ahead: the only record of a price nothing has moved. Called by the engine after every run.';

revoke all on function public.engine_audit_purge(uuid, integer) from public, anon, authenticated;
grant execute on function public.engine_audit_purge(uuid, integer) to service_role;

-- ----------------------------------------------------------------------------
-- 3. A send log and a build stamp (A29)
-- ----------------------------------------------------------------------------

alter table public.evaluation_run_log
  add column if not exists build text;

comment on column public.evaluation_run_log.build is
  'The build that ran this pricing run: "edge@<commit>", "app@<commit>", or "...@dev" when nothing stamped it '
  '(buildStamp in _shared/engine/build.ts). Null on runs from before the column.';

alter table public.rate_updates
  add column if not exists push_run_id uuid,
  add column if not exists build text;

comment on column public.rate_updates.push_run_id is
  'The push run that last wrote this row. Writes that are not a push leave it as it was.';
comment on column public.rate_updates.build is
  'The build of the push run that last wrote this row (buildStamp in _shared/engine/build.ts).';

create table if not exists public.rate_send_log (
  id bigint generated always as identity primary key,
  logged_at timestamptz not null default now(),
  hotel_id uuid not null,
  pms_type text not null,
  room_type_id uuid,
  external_room_type_id text,
  stay_date date not null,
  -- 'insert' for the night's first row, 'update' after.
  write_kind text not null check (write_kind in ('insert', 'update')),
  status text not null,
  price numeric(10,2) not null,
  -- What the row said before this write: the price and status it replaced,
  -- and the price MAYA's last accepted send had left in the PMS.
  price_before numeric(10,2),
  status_before text,
  sent_price_before numeric(10,2),
  sent_price numeric(10,2),
  pms_job_reference text,
  external_rate_id text,
  error text,
  attempts integer,
  pushed_at timestamptz,
  confirmed_at timestamptz,
  pms_edited_at timestamptz,
  -- Set only when the write was a push's (it set them on rate_updates).
  push_run_id uuid,
  build text
);

comment on table public.rate_send_log is
  'Every change to what MAYA''s send ledger (rate_updates) says about a night: each price sent, refused, '
  'held, confirmed or replaced by the hotel''s own rate, with what it replaced. Written by a trigger on '
  'rate_updates; only ever added to, kept 13 months (engine_data_sweep).';

create index if not exists idx_rate_send_log_cell
  on public.rate_send_log (hotel_id, stay_date, room_type_id, logged_at desc);
create index if not exists idx_rate_send_log_logged
  on public.rate_send_log (logged_at);

alter table public.rate_send_log enable row level security;

revoke all on public.rate_send_log from public, anon, authenticated, service_role;
grant select on public.rate_send_log to authenticated, service_role;
-- For engine_data_sweep_proc when the service role calls it; the guard below
-- refuses any row younger than 13 months.
grant delete on public.rate_send_log to service_role;

drop policy if exists rate_send_log_read on public.rate_send_log;
create policy rate_send_log_read on public.rate_send_log
  for select using (public.is_hotel_accessible(hotel_id));

create or replace function public.rate_send_log_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'The send log is only ever added to.' using errcode = 'insufficient_privilege';
  end if;
  if old.logged_at >= now() - interval '13 months' then
    raise exception 'Send log rows are kept 13 months.' using errcode = 'insufficient_privilege';
  end if;
  return old;
end;
$$;

revoke all on function public.rate_send_log_guard() from public, anon, authenticated;

drop trigger if exists trg_rate_send_log_guard on public.rate_send_log;
create trigger trg_rate_send_log_guard
  before update or delete on public.rate_send_log
  for each row execute function public.rate_send_log_guard();

create or replace function public.rate_updates_send_log()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pushed boolean;
begin
  if tg_op = 'UPDATE'
     and new.price is not distinct from old.price
     and new.status is not distinct from old.status
     and new.sent_price is not distinct from old.sent_price
     and new.pms_job_reference is not distinct from old.pms_job_reference
     and new.external_rate_id is not distinct from old.external_rate_id
     and new.error is not distinct from old.error
     and new.attempts is not distinct from old.attempts
     and new.pushed_at is not distinct from old.pushed_at
     and new.confirmed_at is not distinct from old.confirmed_at
     and new.pms_edited_at is not distinct from old.pms_edited_at then
    -- Nothing about the send changed (a Try again press, a run's stamp alone).
    return null;
  end if;
  v_pushed := tg_op = 'INSERT' or new.push_run_id is distinct from old.push_run_id;
  insert into public.rate_send_log (
    hotel_id, pms_type, room_type_id, external_room_type_id, stay_date, write_kind,
    status, price, price_before, status_before, sent_price_before, sent_price,
    pms_job_reference, external_rate_id, error, attempts, pushed_at, confirmed_at, pms_edited_at,
    push_run_id, build
  ) values (
    new.hotel_id, new.pms_type::text, new.room_type_id, new.external_room_type_id, new.stay_date, lower(tg_op),
    new.status, new.price,
    case when tg_op = 'UPDATE' then old.price end,
    case when tg_op = 'UPDATE' then old.status end,
    case when tg_op = 'UPDATE' then old.sent_price end,
    new.sent_price,
    new.pms_job_reference, new.external_rate_id, new.error, new.attempts, new.pushed_at, new.confirmed_at, new.pms_edited_at,
    case when v_pushed then new.push_run_id end,
    case when v_pushed then new.build end
  );
  return null;
end;
$$;

revoke all on function public.rate_updates_send_log() from public, anon, authenticated;

drop trigger if exists trg_rate_updates_send_log on public.rate_updates;
create trigger trg_rate_updates_send_log
  after insert or update on public.rate_updates
  for each row execute function public.rate_updates_send_log();

-- ----------------------------------------------------------------------------
-- 4. The nightly sweep (A31, A29)
-- ----------------------------------------------------------------------------

-- engine_data_sweep_v1's function, the audit loop keeping each night's newest
-- row and a send log loop added.
create or replace function public.engine_data_sweep(
  p_snapshot_days integer default 60,
  p_audit_days integer default 90,
  p_run_log_days integer default 90,
  p_batch integer default 50000
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  removed integer := 0;
  batch_removed integer;
  passes integer;
  -- A night before this has passed everywhere.
  v_passed date := (now() at time zone 'utc')::date - 1;
begin
  -- No surrogate key on the snapshot grid, so the batch is addressed by ctid —
  -- safe here because the subquery and delete run in one statement.
  passes := 0;
  loop
    delete from stay_date_snapshot
     where ctid in (
       select ctid from stay_date_snapshot
        where snapshot_ts < now() - make_interval(days => p_snapshot_days)
        limit p_batch
     );
    get diagnostics batch_removed = row_count;
    removed := removed + batch_removed;
    passes := passes + 1;
    exit when batch_removed < p_batch or passes >= 40;
  end loop;

  -- A night's newest row stays while the night is ahead (engine_audit_purge).
  passes := 0;
  loop
    delete from evaluation_audit
     where id in (
       select a.id from evaluation_audit a
        where a.evaluated_at < now() - make_interval(days => p_audit_days)
          and (a.stay_date < v_passed
               or exists (
                 select 1 from evaluation_audit b
                  where b.hotel_id = a.hotel_id
                    and b.stay_date = a.stay_date
                    and b.room_type_id = a.room_type_id
                    and (b.evaluated_at > a.evaluated_at or (b.evaluated_at = a.evaluated_at and b.id > a.id))
               ))
        order by a.evaluated_at
        limit p_batch
     );
    get diagnostics batch_removed = row_count;
    removed := removed + batch_removed;
    passes := passes + 1;
    exit when batch_removed < p_batch or passes >= 40;
  end loop;

  passes := 0;
  loop
    delete from evaluation_run_log
     where id in (
       select id from evaluation_run_log
        where evaluated_at < now() - make_interval(days => p_run_log_days)
        order by evaluated_at
        limit p_batch
     );
    get diagnostics batch_removed = row_count;
    removed := removed + batch_removed;
    passes := passes + 1;
    exit when batch_removed < p_batch or passes >= 40;
  end loop;

  -- The send log keeps 13 months.
  passes := 0;
  loop
    delete from rate_send_log
     where id in (
       select id from rate_send_log
        where logged_at < now() - interval '13 months'
        order by logged_at
        limit p_batch
     );
    get diagnostics batch_removed = row_count;
    removed := removed + batch_removed;
    passes := passes + 1;
    exit when batch_removed < p_batch or passes >= 40;
  end loop;

  return removed;
end;
$$;

revoke all on function public.engine_data_sweep(integer, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.engine_data_sweep(integer, integer, integer, integer) to service_role;

-- large_property_scale_v1's procedure (commits after every batch), with the
-- same two changes. SECURITY INVOKER and no SET clause, as before: Postgres
-- refuses COMMIT otherwise.
create or replace procedure public.engine_data_sweep_proc(
  p_snapshot_days integer default 60,
  p_audit_days integer default 90,
  p_run_log_days integer default 90,
  p_batch integer default 50000
)
language plpgsql
as $$
declare
  batch_removed integer;
  passes integer;
  -- Fixed once, up front. now() is the transaction's start and every COMMIT
  -- starts a new one, so a cutoff worked out per batch crept forward as the
  -- run went on and deleted rows the one-transaction sweep would have kept.
  v_snapshot_cut timestamptz := now() - make_interval(days => p_snapshot_days);
  v_audit_cut timestamptz := now() - make_interval(days => p_audit_days);
  v_run_log_cut timestamptz := now() - make_interval(days => p_run_log_days);
  v_send_log_cut timestamptz := now() - interval '13 months';
  v_passed date := (now() at time zone 'utc')::date - 1;
begin
  passes := 0;
  loop
    delete from public.stay_date_snapshot
     where ctid in (
       select ctid from public.stay_date_snapshot
        where snapshot_ts < v_snapshot_cut
        limit p_batch
     );
    get diagnostics batch_removed = row_count;
    commit;
    passes := passes + 1;
    exit when batch_removed < p_batch or passes >= 40;
  end loop;

  passes := 0;
  loop
    delete from public.evaluation_audit
     where id in (
       select a.id from public.evaluation_audit a
        where a.evaluated_at < v_audit_cut
          and (a.stay_date < v_passed
               or exists (
                 select 1 from public.evaluation_audit b
                  where b.hotel_id = a.hotel_id
                    and b.stay_date = a.stay_date
                    and b.room_type_id = a.room_type_id
                    and (b.evaluated_at > a.evaluated_at or (b.evaluated_at = a.evaluated_at and b.id > a.id))
               ))
        order by a.evaluated_at
        limit p_batch
     );
    get diagnostics batch_removed = row_count;
    commit;
    passes := passes + 1;
    exit when batch_removed < p_batch or passes >= 40;
  end loop;

  passes := 0;
  loop
    delete from public.evaluation_run_log
     where id in (
       select id from public.evaluation_run_log
        where evaluated_at < v_run_log_cut
        order by evaluated_at
        limit p_batch
     );
    get diagnostics batch_removed = row_count;
    commit;
    passes := passes + 1;
    exit when batch_removed < p_batch or passes >= 40;
  end loop;

  passes := 0;
  loop
    delete from public.rate_send_log
     where id in (
       select id from public.rate_send_log
        where logged_at < v_send_log_cut
        order by logged_at
        limit p_batch
     );
    get diagnostics batch_removed = row_count;
    commit;
    passes := passes + 1;
    exit when batch_removed < p_batch or passes >= 40;
  end loop;
end;
$$;

revoke all on procedure public.engine_data_sweep_proc(integer, integer, integer, integer) from public, anon, authenticated;
grant execute on procedure public.engine_data_sweep_proc(integer, integer, integer, integer) to service_role;

-- ----------------------------------------------------------------------------
-- 5. Pilot health: MAYA's own holds and the build (A28, A29)
-- ----------------------------------------------------------------------------

-- Pilot Health (signups_feed_v1; v6 adds maya_holds, maya_holds_since and
-- last_run_build, otherwise unchanged).
drop function if exists public.platform_pilot_health(boolean);
create function public.platform_pilot_health(
  p_include_test boolean default false
) returns table (
  hotel_id uuid,
  name text,
  timezone text,
  is_test boolean,
  -- 'live' when hotel_settings.simulation_mode is false, else 'simulation'
  -- (a missing settings row counts as simulation, as lib/admin/hotels.ts reads it).
  mode text,
  subscription_status text,
  pms_type public.pms_type,
  pms_status public.connection_status,
  -- Stamped at the end of a successful sync: the last successful read.
  last_sync_at timestamptz,
  down_since timestamptz,
  sync_failures int,
  -- hotel_pricing_state: the last tick that priced without an error, and
  -- where the daily pass has got to.
  last_ok_run_at timestamptz,
  pass_date date,
  pass_cursor date,
  pass_started_at timestamptz,
  pass_completed_at timestamptz,
  pass_horizon_days int,
  -- pricing_dirty_nights: nights waiting, and how long the oldest has waited.
  dirty_count int,
  dirty_oldest_marked_at timestamptz,
  -- rate_updates sent in the last 24 hours.
  sent_24h int,
  -- rate_push_incidents still open: the ones an owner may be told about,
  -- when the oldest opened, and MAYA's own holds (admin_only) counted apart.
  open_incidents int,
  open_incidents_since timestamptz,
  open_incidents_admin_only int,
  open_incident_causes text[],
  active_rules int,
  -- product_events in the last 24 hours that changed a rule: created,
  -- edited, enabled, disabled, deleted, undo ticked or unticked. Opening the
  -- editor or the activation popup, a preview, and the popup's choice are
  -- rule.* events too, and change nothing on their own.
  rule_changes_24h int,
  -- v2. Published prices of a Live hotel waiting over an hour with no sent
  -- record at that price, and since when the oldest has waited. v3 leaves
  -- out the nights of a type unticked as a room that no rule names.
  unsent_count int,
  unsent_since timestamptz,
  -- v2. Nights held until the hotel's own rates have been read, and since when.
  rate_read_waiting int,
  rate_read_waiting_since timestamptz,
  -- v4. Room-nights ahead with no rate on record from the property system
  -- and no typed price: not priced, not sent. And the last night the
  -- property system returned a rate for. v5 counts a rate removed in the
  -- property system too, unless a price was typed after the removal.
  no_rate_count int,
  rates_read_through date,
  -- v6 (pricing_records_v1). Room-nights MAYA holds back with a guardrail
  -- that should never fire (a price that is not a number, unusable limits,
  -- a price no recent run backs), and since when the first was held.
  maya_holds int,
  maya_holds_since timestamptz,
  -- v6. The build that ran the hotel's latest pricing run (evaluation_run_log.build).
  last_run_build text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if (select auth.role()) is distinct from 'service_role'
     and not public.staff_can_read('pilot_health') then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  return query
    select
      h.id,
      h.name,
      h.timezone,
      h.is_test,
      case when hs.simulation_mode = false then 'live' else 'simulation' end,
      s.status,
      pc.pms_type,
      pc.status,
      pc.last_sync_at,
      pc.down_since,
      pc.sync_failures,
      ps.last_ok_run_at,
      ps.pass_date,
      ps.pass_cursor,
      ps.pass_started_at,
      ps.pass_completed_at,
      ps.pass_horizon_days,
      dn.dirty_count,
      dn.oldest_marked_at,
      su.sent_24h,
      inc.open_incidents,
      inc.open_since,
      inc.open_admin_only,
      inc.causes,
      pr.active_rules,
      pe.rule_changes_24h,
      un.unsent_count,
      un.unsent_since,
      rr.rate_read_waiting,
      rr.rate_read_waiting_since,
      nr.no_rate_count,
      pc.base_rates_returned_through,
      mh.maya_holds,
      mh.maya_holds_since,
      lr.build
    from public.hotels h
    left join public.hotel_settings hs on hs.hotel_id = h.id
    left join public.hotel_subscriptions s on s.hotel_id = h.id
    left join lateral (
      select c.pms_type, c.status, c.last_sync_at, c.down_since, c.sync_failures, c.base_rates_returned_through
        from public.pms_connections c
       where c.hotel_id = h.id
       order by (c.status = 'connected') desc, c.updated_at desc, c.created_at desc
       limit 1
    ) pc on true
    left join public.hotel_pricing_state ps on ps.hotel_id = h.id
    left join lateral (
      select count(*)::int as dirty_count, min(d.first_marked_at) as oldest_marked_at
        from public.pricing_dirty_nights d
       where d.hotel_id = h.id
    ) dn on true
    left join lateral (
      select count(*)::int as sent_24h
        from public.rate_updates ru
       where ru.hotel_id = h.id
         and ru.status = 'sent'
         and ru.pushed_at >= now() - interval '24 hours'
    ) su on true
    left join lateral (
      select count(*) filter (where not i.admin_only)::int as open_incidents,
             min(i.opened_at) filter (where not i.admin_only) as open_since,
             count(*) filter (where i.admin_only)::int as open_admin_only,
             coalesce(array_agg(i.cause order by i.opened_at) filter (where not i.admin_only), '{}'::text[]) as causes
        from public.rate_push_incidents i
       where i.hotel_id = h.id
         and i.resolved_at is null
    ) inc on true
    left join lateral (
      select count(*)::int as active_rules
        from public.pricing_rules r
       where r.hotel_id = h.id
         and r.is_active
    ) pr on true
    left join lateral (
      select count(*)::int as rule_changes_24h
        from public.product_events e
       where e.hotel_id = h.id
         and e.event in ('rule.created', 'rule.edited', 'rule.enabled', 'rule.disabled',
                         'rule.deleted', 'rule.undo_ticked', 'rule.undo_unticked')
         and e.occurred_at >= now() - interval '24 hours'
    ) pe on true
    left join lateral (
      select count(*)::int as unsent_count,
             min(greatest(pp.computed_at, coalesce(hs.live_since, pp.computed_at))) as unsent_since
        from public.published_price pp
        join public.room_types rt
          on rt.id = pp.room_type_id
         and rt.is_active
        left join public.rate_updates ru
          on ru.hotel_id = pp.hotel_id
         and ru.room_type_id = pp.room_type_id
         and ru.stay_date = pp.stay_date
       where pp.hotel_id = h.id
         and hs.simulation_mode = false
         and pc.pms_type in ('cloudbeds', 'think')
         and pp.price > 0
         and pp.stay_date > (now() at time zone 'utc')::date
         and pp.stay_date < (now() at time zone 'utc')::date + (coalesce(ps.pass_horizon_days, 396) - 1)
         and greatest(pp.computed_at, coalesce(hs.live_since, pp.computed_at)) < now() - interval '1 hour'
         and (ru.id is null or ru.status <> 'sent' or ru.price is distinct from pp.price)
         -- v3. A type unticked as a room that no rule names is held on
         -- purpose (guardrail:not_a_room, rate-push.ts): the PMS keeps its
         -- own rate for it, and nothing is waiting.
         and (ru.id is null or ru.status <> 'skipped' or ru.error is distinct from 'guardrail:not_a_room')
         -- v4. A night the property system has no rate on record for is
         -- held on purpose too (guardrail:no_rate_on_record), and counted
         -- under no_rate_count instead.
         and (ru.id is null or ru.status <> 'skipped' or ru.error is distinct from 'guardrail:no_rate_on_record')
    ) un on true
    left join lateral (
      select count(*)::int as rate_read_waiting,
             min(c.first_attempt_at) as rate_read_waiting_since
        from public.rate_push_incident_cells c
        join public.rate_push_incidents i on i.id = c.incident_id
       where c.hotel_id = h.id
         and c.state = 'open'
         and i.resolved_at is null
         and i.cause = 'awaiting_rate_read'
    ) rr on true
    left join lateral (
      select count(*)::int as no_rate_count
        from generate_series(
               ((now() at time zone 'utc')::date + 1)::timestamp,
               ((now() at time zone 'utc')::date + (coalesce(ps.pass_horizon_days, 396) - 2))::timestamp,
               interval '1 day'
             ) as g(d)
        cross join public.room_types rt
        left join public.base_rate_calendar brc
          on brc.hotel_id = h.id
         and brc.room_type_id = rt.id
         and brc.stay_date = g.d::date
        left join public.manual_price mp
          on mp.hotel_id = h.id
         and mp.room_type_id = rt.id
         and mp.stay_date = g.d::date
         and mp.cleared_at is null
       where pc.pms_type in ('cloudbeds', 'think')
         and rt.hotel_id = h.id
         and rt.is_active
         and rt.counts_as_room is distinct from false
         -- v5. A typed price stands, unless the property system removed the
         -- night's rate after it was typed (evaluate.ts, removedInPmsAt).
         and (mp.stay_date is null
              or (brc.pms_removed_at is not null and mp.set_at <= brc.pms_removed_at))
         and (brc.stay_date is null
              -- v5. A rate the property system removed after MAYA sent to
              -- the night (pms_rate_changes_v1) is no rate on record.
              or brc.pms_removed_at is not null
              or (pc.base_rates_returned_through is not null and g.d::date > pc.base_rates_returned_through))
    ) nr on true
    left join lateral (
      select count(*)::int as maya_holds,
             min(c.first_attempt_at) as maya_holds_since
        from public.rate_push_incident_cells c
        join public.rate_push_incidents i on i.id = c.incident_id
       where c.hotel_id = h.id
         and c.state = 'open'
         and i.resolved_at is null
         and i.admin_only
         -- The guardrails push-failure.ts marks mayaBug.
         and i.cause in ('guardrail_invalid_price', 'guardrail_invalid_bounds', 'guardrail_stale_price')
    ) mh on true
    left join lateral (
      select l.build
        from public.evaluation_run_log l
       where l.hotel_id = h.id
       order by l.evaluated_at desc
       limit 1
    ) lr on true
    where h.is_active
      and h.setup_pending_at is null
      and h.data_purged_at is null
      and (p_include_test or not h.is_test)
      and (s.hotel_id is null or s.status in ('trialing', 'active', 'past_due'))
    order by h.name;
end;
$$;

comment on function public.platform_pilot_health(boolean) is
  'One row per active, entitled property with where its connection, pricing, '
  'sending and rules stand right now, published prices that have waited over '
  'an hour to be sent included (nights of a type unticked as a room that no '
  'rule names, and nights the property system has no rate on record for, are '
  'not waiting), the room-nights ahead with no rate on record (a rate removed '
  'in the property system included), the room-nights MAYA holds back with a '
  'guardrail that should never fire and since when, and the build of the '
  'latest pricing run. Read by /admin/pilot-health. Platform admins, staff at '
  'aal2 with the pilot_health section, and the service role.';

revoke all on function public.platform_pilot_health(boolean) from public, anon;
grant execute on function public.platform_pilot_health(boolean) to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
