-- MAYA Push Guardrails v1 Migration
--
-- 1. pms_connections.base_rates_refreshed_at — when the base rate calendar was
--    last re-read from the PMS for this hotel. The scheduled tick used to read
--    each night's base rate once, about 45 days out, and never again, so a
--    rate the hotel changed in its PMS during simulation was written over by
--    the first live push. The tick now re-reads the whole pricing window, at
--    most once an hour per hotel (MAYA_BASE_RATE_REFRESH_MINUTES) and again
--    as soon as the hotel's date moves, and writes only the cells that
--    changed. An unchanged calendar costs no writes to base_rate_calendar,
--    so its captured_at can't say when the last read happened; this column
--    does.
--
-- 2. Clears the cached push targets (pms_connections.push_rate_targets). The
--    resolver used to fall back to another non-derived rate plan, such as a
--    package, when a room type had no base rate, and a map it cached keeps
--    being used for as long as it covers the room types being pushed. Cleared,
--    the next push re-resolves under the base-rate-only rule. Deploy the code
--    straight after this runs: until then the old code can cache the old
--    choice again. Re-running this only costs one catalog read per hotel.
--
-- 3. Rate push incidents (rate_push_incidents, rate_push_incident_cells,
--    rate_push_attempts, rate_push_incident_sweep). A rejected rate used to
--    leave one console line per cell per tick and nothing else. Every failure
--    is now filed under a cause code (_shared/pms/push-failure.ts): one open
--    incident per hotel, PMS and cause, the cells it affects and the tries
--    made at them. Owners see an incident in the change log only once it
--    needs a person; admins see all of them in analytics. See section 3 below.
--
-- Run AFTER 99_supabase_migration_rate_push_v1.sql,
-- 99_supabase_migration_roles_v2_part2.sql (is_hotel_accessible) and
-- 99_supabase_migration_rls_helpers_lockdown_v1.sql (is_platform_admin).
-- Idempotent. Code deployed ahead of sections 1 and 2 fills calendar gaps
-- only, as before, and logs that the column is missing. Code deployed ahead
-- of section 3 still pushes; recording incidents fails and is logged
-- (rate_push_incident_write_failed) on every run that has a failure.
--
-- NOT mirrored into 02_supabase_schema.sql yet — fold it in on the next
-- schema consolidation pass.

begin;

alter table public.pms_connections
  add column if not exists base_rates_refreshed_at timestamptz;

comment on column public.pms_connections.base_rates_refreshed_at is
  'Instant of the scheduled tick that last re-read this hotel''s base rates '
  'from the PMS into base_rate_calendar. Throttles the refresh; null = never.';

update public.pms_connections
   set push_rate_targets = null
 where push_rate_targets is not null;

commit;

-- ============================================================================
-- 3. Rate push incidents
-- ============================================================================
--
-- rate_push_incidents: one row per (hotel, PMS, cause) episode. At most one
-- is open (resolved_at null) per hotel, PMS and cause. It closes when none of
-- its cells is failing for that cause any more, and `resolution` says how
-- most of them ended: landed, superseded (a new price, or now failing for
-- another cause) or stopped (no longer pushed). customer_visible_at is set
-- when the owner should hear about it: a known critical cause at once, or a
-- retrying one whose cell has failed for 2 hours over 5 tries. Guardrail
-- causes are admin_only and never visible to owners. An incident that closes
-- before either never shows and never alerts.
--
-- rate_push_incident_cells: one row per (incident, room type, night) it
-- touched, open until it closes one of the three ways above.
--
-- rate_push_attempts: every try at an incident's cells (refused send,
-- rejected or unconfirmed job, guardrail skip, and the send that finally
-- landed), with the vendor's message cut to 300 characters. Never guest data:
-- it is what the PMS said about a rate write.
--
-- Storage is bounded three ways. Attempts stop being stored at 500 per
-- incident (push-incidents.ts MAX_STORED_ATTEMPTS); attempt_count keeps
-- counting and attempts_stored says how many rows exist. Cells are one row
-- per night and room type per incident, so a cause can only add rows as
-- nights enter the push window while it stays open. And
-- rate_push_incident_sweep() deletes incidents resolved more than 180 days
-- ago, their cells and attempts with them.
--
-- The sweep also closes what the push cannot see: cells on nights that are
-- over, and every open cell of a hotel that is not live any more (the push
-- returns before reading anything for those). Schedule it hourly:
-- supabase/cron/rate-push-incident-sweep.sql.example.
--
-- RLS: only the service role writes. A member of the hotel (any role) reads
-- its customer-visible incidents and their cells and attempts; platform
-- admins read everything. No delete policy for anyone signed in, per
-- 99_supabase_migration_no_customer_deletes_v1.sql.

begin;

create table if not exists public.rate_push_incidents (
  id                  uuid primary key default gen_random_uuid(),
  hotel_id            uuid not null references public.hotels(id) on delete cascade,
  pms_type            public.pms_type not null,
  cause               text not null,
  known               boolean not null,
  severity            text not null check (severity in ('transient', 'critical')),
  admin_only          boolean not null default false,
  opened_at           timestamptz not null,
  last_attempt_at     timestamptz,
  attempt_count       integer not null default 0 check (attempt_count >= 0),
  attempts_stored     integer not null default 0 check (attempts_stored >= 0),
  cells_landed        integer not null default 0 check (cells_landed >= 0),
  cells_superseded    integer not null default 0 check (cells_superseded >= 0),
  cells_stopped       integer not null default 0 check (cells_stopped >= 0),
  customer_visible_at timestamptz,
  alerted_at          timestamptz,
  resolved_at         timestamptz,
  resolution          text check (resolution in ('landed', 'superseded', 'stopped')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint rate_push_incidents_resolution_chk check ((resolved_at is null) = (resolution is null)),
  constraint rate_push_incidents_admin_only_chk check (not (admin_only and customer_visible_at is not null))
);

comment on table public.rate_push_incidents is
  'Why rates are not landing in the PMS, one row per hotel, PMS and cause episode. '
  'Written by the service role from pushRatesForHotel (_shared/pms/push-incidents.ts); '
  'cause codes are defined in _shared/pms/push-failure.ts.';

-- The push's own read, and the one-open-per-cause rule.
create unique index if not exists uq_rate_push_incidents_open
  on public.rate_push_incidents (hotel_id, pms_type, cause)
  where resolved_at is null;
-- Reopening one that closed in the last hour.
create index if not exists idx_rate_push_incidents_recently_resolved
  on public.rate_push_incidents (hotel_id, pms_type, cause, resolved_at desc)
  where resolved_at is not null;
-- The change log: a hotel's visible incidents, newest first.
create index if not exists idx_rate_push_incidents_visible
  on public.rate_push_incidents (hotel_id, opened_at desc)
  where customer_visible_at is not null;
-- Admin analytics over a date range.
create index if not exists idx_rate_push_incidents_opened
  on public.rate_push_incidents (opened_at);
-- The sweep's retention cutoff.
create index if not exists idx_rate_push_incidents_resolved
  on public.rate_push_incidents (resolved_at)
  where resolved_at is not null;

create table if not exists public.rate_push_incident_cells (
  incident_id      uuid not null references public.rate_push_incidents(id) on delete cascade,
  hotel_id         uuid not null references public.hotels(id) on delete cascade,
  room_type_id     uuid not null references public.room_types(id) on delete cascade,
  stay_date        date not null,
  price            numeric(10,2) not null,
  state            text not null check (state in ('open', 'landed', 'superseded', 'stopped')),
  attempts         integer not null default 0 check (attempts >= 0),
  first_attempt_at timestamptz not null,
  last_attempt_at  timestamptz not null,
  closed_at        timestamptz,
  primary key (incident_id, room_type_id, stay_date)
);

comment on table public.rate_push_incident_cells is
  'The room-nights a rate push incident affects: open while still failing for its cause.';

-- The sweep's look for open cells on nights that are over.
create index if not exists idx_rate_push_incident_cells_open
  on public.rate_push_incident_cells (stay_date)
  where state = 'open';

create table if not exists public.rate_push_attempts (
  id            uuid primary key default gen_random_uuid(),
  incident_id   uuid not null references public.rate_push_incidents(id) on delete cascade,
  hotel_id      uuid not null references public.hotels(id) on delete cascade,
  attempted_at  timestamptz not null,
  stay_date     date not null,
  room_type_id  uuid not null references public.room_types(id) on delete cascade,
  price         numeric(10,2) not null,
  phase         text not null check (phase in ('send', 'job', 'guardrail')),
  outcome       text not null check (outcome in ('failed', 'rejected', 'skipped', 'unconfirmed', 'landed')),
  http_status   integer,
  message       text check (message is null or char_length(message) <= 300),
  job_reference text,
  created_at    timestamptz not null default now()
);

comment on table public.rate_push_attempts is
  'Tries at a rate push incident''s cells. message is the vendor''s text about the write, '
  'cut to 300 characters, or a skip''s reason code. At most 500 rows per incident.';

-- The change log's condensed retries and the admin panel's sample messages.
create index if not exists idx_rate_push_attempts_incident
  on public.rate_push_attempts (incident_id, attempted_at);

alter table public.rate_push_incidents enable row level security;
alter table public.rate_push_incident_cells enable row level security;
alter table public.rate_push_attempts enable row level security;

revoke all on public.rate_push_incidents, public.rate_push_incident_cells, public.rate_push_attempts from anon;
revoke insert, update, delete, truncate
  on public.rate_push_incidents, public.rate_push_incident_cells, public.rate_push_attempts
  from authenticated;
grant select on public.rate_push_incidents, public.rate_push_incident_cells, public.rate_push_attempts
  to authenticated;
grant select, insert, update, delete
  on public.rate_push_incidents, public.rate_push_incident_cells, public.rate_push_attempts
  to service_role;

drop policy if exists rate_push_incidents_read on public.rate_push_incidents;
create policy rate_push_incidents_read on public.rate_push_incidents
  for select to authenticated
  using (
    public.is_platform_admin()
    or (
      customer_visible_at is not null
      and not admin_only
      and public.is_hotel_accessible(hotel_id)
    )
  );

drop policy if exists rate_push_incident_cells_read on public.rate_push_incident_cells;
create policy rate_push_incident_cells_read on public.rate_push_incident_cells
  for select to authenticated
  using (
    public.is_platform_admin()
    or exists (
      select 1
        from public.rate_push_incidents i
       where i.id = rate_push_incident_cells.incident_id
         and i.customer_visible_at is not null
         and not i.admin_only
         and public.is_hotel_accessible(i.hotel_id)
    )
  );

drop policy if exists rate_push_attempts_read on public.rate_push_attempts;
create policy rate_push_attempts_read on public.rate_push_attempts
  for select to authenticated
  using (
    public.is_platform_admin()
    or exists (
      select 1
        from public.rate_push_incidents i
       where i.id = rate_push_attempts.incident_id
         and i.customer_visible_at is not null
         and not i.admin_only
         and public.is_hotel_accessible(i.hotel_id)
    )
  );

-- Closes what the push cannot see, then deletes old resolved incidents in
-- batches. Returns how many incidents it deleted.
create or replace function public.rate_push_incident_sweep(
  p_keep_days integer default 180,
  p_batch integer default 5000
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  removed integer := 0;
  batch_removed integer;
  passes integer := 0;
begin
  -- Open cells nobody pushes any more: the night is over everywhere (a day of
  -- slack covers every time zone), or the hotel is not live (a missing
  -- settings row counts as simulation, as it does in the push).
  with stopped as (
    update public.rate_push_incident_cells c
       set state = 'stopped',
           closed_at = now()
      from public.rate_push_incidents i
     where i.id = c.incident_id
       and i.resolved_at is null
       and c.state = 'open'
       and (
         c.stay_date < (now() at time zone 'utc')::date - 1
         or not exists (
           select 1
             from public.hotel_settings s
            where s.hotel_id = i.hotel_id
              and s.simulation_mode = false
         )
       )
    returning c.incident_id
  )
  update public.rate_push_incidents i
     set cells_stopped = i.cells_stopped + n.cells,
         updated_at = now()
    from (select incident_id, count(*)::integer as cells from stopped group by incident_id) n
   where i.id = n.incident_id;

  -- Open incidents with nothing left open. Same tie order as the code
  -- (resolutionOf): landed, then superseded, then stopped. Left alone for ten
  -- minutes after a write, so a push writing a new incident before its cells
  -- is never closed under it.
  update public.rate_push_incidents i
     set resolved_at = now(),
         resolution = case
           when i.cells_landed > 0
                and i.cells_landed >= i.cells_superseded
                and i.cells_landed >= i.cells_stopped then 'landed'
           when i.cells_superseded > 0
                and i.cells_superseded >= i.cells_stopped then 'superseded'
           else 'stopped'
         end,
         updated_at = now()
   where i.resolved_at is null
     and i.updated_at < now() - interval '10 minutes'
     and not exists (
       select 1
         from public.rate_push_incident_cells c
        where c.incident_id = i.id
          and c.state = 'open'
     );

  loop
    delete from public.rate_push_incidents
     where id in (
       select id
         from public.rate_push_incidents
        where resolved_at < now() - make_interval(days => p_keep_days)
        order by resolved_at
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

revoke all on function public.rate_push_incident_sweep(integer, integer) from public, anon, authenticated;
grant execute on function public.rate_push_incident_sweep(integer, integer) to service_role;

commit;

-- Check afterwards:
--
--   select tablename, policyname, cmd from pg_policies
--    where tablename like 'rate_push_%' order by tablename;
--   -- one SELECT policy per table, nothing else
--
--   select indexname from pg_indexes where tablename like 'rate_push_%' order by indexname;
