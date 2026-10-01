-- ============================================================================
-- MAYA: which mode a property was in at any moment, v1
-- ============================================================================
--
-- Jake, 2026-09-30, after looking at a pilot property: "I can't even tell
-- that it's in simulation mode". The change log told a simulated run the same way as
-- a live one ("raised this night 10%, from $150.00 to $165.00"), so a run
-- that sent nothing read as if it had changed a rate. The log now words a
-- simulated item as what would have happened, and a label has to follow the
-- mode at the TIME of the item: a run recorded while simulating stays a
-- simulation after the property goes live.
--
-- Nothing recorded the mode per event. hotel_settings.simulation_mode is the
-- mode now; live_since is only the last time it went live. This file keeps
-- the whole history, one row per switch, and the app reads the mode of any
-- event (a pricing run, a rule's fire, an owner's answer) off it by the
-- event's own time:
--
--   1. hotel_mode_history: from `since` until the next row of the same
--      property, the property was simulating (simulated true), live (false),
--      or MAYA cannot tell (null). Members of the property read their own
--      rows (is_hotel_accessible, as every hotel table); only this file's
--      trigger and the service role write.
--
--   2. From now on: a trigger on hotel_settings writes a row on every switch
--      (insert, or simulation_mode changed), at the switch's own instant
--      (now(), the same instant live_since and the product event get), with
--      who made it (auth.uid(): null under the service role, so for the
--      Command Center's switch and the owner's go-live route alike; those
--      record the person in platform_audit_events already). source 'switch'.
--
--   3. hotel_simulated_at(hotel, at): the mode at an instant (true, false, or
--      null when not known). Security invoker, so RLS decides whose rows it
--      reads, exactly as a select would.
--
--   4. The backfill: the history before this file, as well as the records
--      allow and no further. Once per property (a property with any row is
--      left alone, so a second run adds nothing). source 'backfill', and
--      `basis` says what each row stands on:
--
--        product_event    property.went_live / property.back_to_simulation
--                         written by the product events trigger at the switch
--                         (99_supabase_migration_product_events_v1.sql). Exact.
--                         The rows that file's own backfill wrote are not
--                         switches (their time is hotel_settings.updated_at,
--                         which nothing keeps current) and are used only as
--                         live_when_tracking_began below.
--        audit_event      hotel.went_live (the owner's go-live) and
--                         hotel.simulation_mode_changed (the Command Center's
--                         switch) in platform_audit_events, written just after
--                         the switch.
--        live_since       hotel_settings.live_since: the last go-live, exact,
--                         and the only record of a property created live.
--        live_when_tracking_began
--                         the product events file found the property live when
--                         it ran (its own backfilled property.went_live): live
--                         at that row's recorded_at, the file's run time.
--        never_live       the property is simulating, nothing records a switch
--                         or a go-live of any kind, and it has no row in
--                         rate_updates (MAYA's send ledger, written only by
--                         sends to a live property): every event it ever had
--                         was simulated. The pilot properties are here.
--        before_first_go_live
--                         the earliest switch on record is a go-live, the
--                         property was not live when tracking began, and no
--                         send is on record before that go-live: simulating
--                         from the start until then.
--        not_known_before anything else (the earliest switch on record took
--                         it back to simulation, it was live when tracking
--                         began, or a send predates every record): before the
--                         first row MAYA cannot tell, and says neither.
--        state_at_backfill
--                         the mode when this file ran, which is certain.
--
--      What the inference cannot see: a property that was live and went back
--      to simulation before product events existed (2026-09-16), with every
--      send of that time since overwritten in the one-row-per-night ledger by
--      a later live period. Its earliest stretch would read as simulated. No
--      such property is known; rate_updates.created_at (kept across resends)
--      makes it unlikely.
--
-- Nothing else changes, and nothing reads the table until the app does. The
-- app treats a missing table as "mode not known" and words items as it did
-- before, so deploy order does not matter.
--
-- The PGlite test runs this file twice (simulation-history-migration-sql.test.ts).
-- Run AFTER 99_supabase_migration_staff_roles_v1.sql. One transaction.
-- Idempotent: the table, index and policy are made only when missing or
-- replaced, the functions are replaced, and the backfill skips every property
-- that already has a row.
-- ============================================================================

begin;

do $$
begin
  if to_regclass('public.product_events') is null
     or to_regclass('public.platform_audit_events') is null
     or to_regclass('public.rate_updates') is null
     or to_regprocedure('public.is_hotel_accessible(uuid)') is null
     or to_regprocedure('public.staff_access()') is null then
    raise exception 'Run every migration before 99_supabase_migration_simulation_history_v1.sql first';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'hotel_settings' and column_name = 'live_since'
  ) then
    raise exception 'Run 99_supabase_migration_push_guardrails_v1.sql first';
  end if;
end $$;

-- ── 1. The history ─────────────────────────────────────────────────────────

create table if not exists public.hotel_mode_history (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  since timestamptz not null,
  simulated boolean,
  source text not null,
  basis text,
  changed_by uuid,
  recorded_at timestamptz not null default now()
);

alter table public.hotel_mode_history drop constraint if exists hotel_mode_history_source_check;
alter table public.hotel_mode_history add constraint hotel_mode_history_source_check
  check (
    (source = 'switch' and basis is null and simulated is not null)
    or (source = 'backfill' and basis in (
      'product_event', 'audit_event', 'live_since', 'live_when_tracking_began',
      'never_live', 'before_first_go_live', 'not_known_before', 'state_at_backfill'
    ))
  );

create index if not exists idx_hotel_mode_history_hotel_since
  on public.hotel_mode_history (hotel_id, since desc);

comment on table public.hotel_mode_history is
  'Which mode a property was in, by time: from `since` until the property''s next row it was simulating '
  '(simulated true), live (false) or not known (null). source ''switch'': written by a trigger on '
  'hotel_settings at the switch. source ''backfill'': rebuilt once from the records before '
  '99_supabase_migration_simulation_history_v1.sql, `basis` naming the record. Read a moment''s mode with '
  'hotel_simulated_at(hotel, at). Kept for good, like the rest of a property''s history.';
comment on column public.hotel_mode_history.changed_by is
  'Who switched, when the switch ran under their own session (auth.uid()). Null under the service role '
  '(the go-live route and the Command Center switch; platform_audit_events names the person for both) and '
  'on backfilled rows.';

alter table public.hotel_mode_history enable row level security;

revoke all on public.hotel_mode_history from public, anon, authenticated, service_role;
grant select on public.hotel_mode_history to authenticated;
grant select, insert, update, delete on public.hotel_mode_history to service_role;

drop policy if exists hotel_mode_history_read on public.hotel_mode_history;
create policy hotel_mode_history_read on public.hotel_mode_history
  for select using (public.is_hotel_accessible(hotel_id));

-- ── 2. Every switch from now on ────────────────────────────────────────────

-- A trigger function: it runs as its owner so a General Manager's go-live
-- (or an insert under any role) can write the row the table grants nobody
-- else. It writes only what the switch itself says.
create or replace function public.hotel_mode_history_record()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' or new.simulation_mode is distinct from old.simulation_mode then
    insert into public.hotel_mode_history (hotel_id, since, simulated, source, changed_by)
    values (new.hotel_id, now(), coalesce(new.simulation_mode, true), 'switch', auth.uid());
  end if;
  return null;
end;
$$;

revoke all on function public.hotel_mode_history_record() from public, anon, authenticated;

drop trigger if exists trg_hotel_mode_history on public.hotel_settings;
create trigger trg_hotel_mode_history
  after insert or update of simulation_mode on public.hotel_settings
  for each row execute function public.hotel_mode_history_record();

-- ── 3. The mode at a moment ────────────────────────────────────────────────

create or replace function public.hotel_simulated_at(p_hotel_id uuid, p_at timestamptz)
returns boolean
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select m.simulated
    from public.hotel_mode_history m
   where m.hotel_id = p_hotel_id
     and m.since <= p_at
   order by m.since desc, m.recorded_at desc, m.id desc
   limit 1
$$;

comment on function public.hotel_simulated_at(uuid, timestamptz) is
  'The mode a property was in at p_at, from hotel_mode_history: true simulating, false live, null not known '
  '(no row at or before p_at, or the row there says it is not known). Reads under the caller''s RLS.';

revoke all on function public.hotel_simulated_at(uuid, timestamptz) from public, anon;
grant execute on function public.hotel_simulated_at(uuid, timestamptz) to authenticated, service_role;

-- ── 4. The history before this file ────────────────────────────────────────

do $backfill$
declare
  h record;
  v_first_at timestamptz;
  v_first_simulated boolean;
  v_tracking_live timestamptz;
  v_sent_before boolean;
  v_basis text;
  v_simulated boolean;
  n integer := 0;
begin
  for h in
    select ho.id as hotel_id,
           coalesce(hs.simulation_mode, true) as sim_now,
           hs.live_since
      from public.hotels ho
      left join public.hotel_settings hs on hs.hotel_id = ho.id
     where not exists (select 1 from public.hotel_mode_history m where m.hotel_id = ho.id)
     order by ho.id
  loop
    n := n + 1;

    -- The switches on record, exactly as recorded.
    insert into public.hotel_mode_history (hotel_id, since, simulated, source, basis)
    select h.hotel_id, s.at, s.simulated, 'backfill', s.basis
      from (
        select e.occurred_at as at, (e.event = 'property.back_to_simulation') as simulated, 'product_event' as basis
          from public.product_events e
         where e.hotel_id = h.hotel_id
           and e.event in ('property.went_live', 'property.back_to_simulation')
           and e.source <> 'backfill'
        union all
        select a.created_at, false, 'audit_event'
          from public.platform_audit_events a
         where a.hotel_id = h.hotel_id and a.event_type = 'hotel.went_live'
        union all
        select a.created_at, (a.detail->>'simulation_mode')::boolean, 'audit_event'
          from public.platform_audit_events a
         where a.hotel_id = h.hotel_id
           and a.event_type = 'hotel.simulation_mode_changed'
           and a.detail->>'simulation_mode' in ('true', 'false')
        union all
        select h.live_since, false, 'live_since'
         where h.live_since is not null
      ) s;

    -- Live when product events began, by that file's own backfill.
    select min(e.recorded_at) into v_tracking_live
      from public.product_events e
     where e.hotel_id = h.hotel_id
       and e.event = 'property.went_live'
       and e.source = 'backfill';
    if v_tracking_live is not null then
      insert into public.hotel_mode_history (hotel_id, since, simulated, source, basis)
      values (h.hotel_id, v_tracking_live, false, 'backfill', 'live_when_tracking_began');
    end if;

    -- Before anything on record.
    v_first_at := null;
    v_first_simulated := null;
    select m.since, m.simulated into v_first_at, v_first_simulated
      from public.hotel_mode_history m
     where m.hotel_id = h.hotel_id and m.basis in ('product_event', 'audit_event', 'live_since')
     order by m.since asc
     limit 1;
    v_sent_before := exists (
      select 1 from public.rate_updates r
       where r.hotel_id = h.hotel_id
         and (v_first_at is null or r.created_at < v_first_at)
    );

    if v_first_at is null and h.sim_now and v_tracking_live is null and not v_sent_before then
      v_basis := 'never_live';
      v_simulated := true;
    elsif v_first_at is not null and v_first_simulated = false
          and v_tracking_live is null and not v_sent_before then
      v_basis := 'before_first_go_live';
      v_simulated := true;
    else
      v_basis := 'not_known_before';
      v_simulated := null;
    end if;
    insert into public.hotel_mode_history (hotel_id, since, simulated, source, basis)
    values (h.hotel_id, '-infinity', v_simulated, 'backfill', v_basis);

    -- The mode as this file found it, which is certain.
    insert into public.hotel_mode_history (hotel_id, since, simulated, source, basis)
    values (h.hotel_id, now(), h.sim_now, 'backfill', 'state_at_backfill');
  end loop;
  raise notice 'hotel_mode_history: backfilled % properties', n;
end
$backfill$;

commit;

-- Check afterwards:
--
--   select h.name, m.since, m.simulated, m.source, m.basis
--     from public.hotel_mode_history m join public.hotels h on h.id = m.hotel_id
--    order by h.name, m.since;
--
--   -- Every property has a row, and each one's newest row matches its setting now:
--   select h.name, hs.simulation_mode, public.hotel_simulated_at(h.id, now())
--     from public.hotels h left join public.hotel_settings hs on hs.hotel_id = h.id
--    where public.hotel_simulated_at(h.id, now()) is distinct from coalesce(hs.simulation_mode, true);  -- no rows
