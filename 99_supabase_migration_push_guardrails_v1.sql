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
-- 4. evaluation_run_log.first_stay_date / last_stay_date — the nights a run
--    priced. When a tick's own evaluation fails, the push accepts a logged
--    run as proof a price is current, and a manual price save evaluates only
--    up to the night it changed. A logged run now vouches for its nights
--    only. Rows written before this carry nulls and vouch for nothing.
--
-- 5. pms_connections.reauthorized_at — when a person last stored a new grant
--    (the PMS tab's reconnect, or a Marketplace reconnect). A cell held for a
--    missing rate permission or a refused grant waited a day even after the
--    owner fixed it; a reconnect newer than its last try now ends the hold.
--
-- 6. Legacy "no rate target" skips. The old push wrote every skip with
--    attempts 1, even on nights it never sent to, and the base rate calendar
--    treats attempts 1 as sent to, so those nights were never read again. A
--    skip's own row can't say whether a send sits under it: the old push
--    wrote skips and sends in the same bulk upsert, and PostgREST sets every
--    column a row leaves out to null when the rows of one chunk differ, so a
--    skip that overwrote a real send can have lost its job reference and rate
--    id too. Only a room type with no sent or failed row on any night, past
--    nights included, is taken as never sent to, and its skips go back to
--    attempts 0; every other skip stays frozen. Run the count in section 6
--    first. Safe to run again after the code is deployed: its skips keep the
--    reference and rate id of whatever they overwrite, and write 0 only
--    where nothing was ever sent.
--
-- 7. rate_updates.sent_price — the price MAYA's last accepted send left in the
--    PMS for the night. A held-back row keeps it from the send under it; a
--    refused or unconfirmed send clears it. The base rate calendar takes a
--    rate on a sent-to night stored at 0 as the hotel's own only when it
--    differs from this. Comparing with the row's own price, whatever its
--    status, let an earlier send of MAYA's that was still in the PMS, under a
--    later price that never landed, be captured as the hotel's rate. Sent
--    rows are backfilled; a held-back row written before this has none, and
--    its night stays frozen.
--
-- 8. A rate the hotel changes in its PMS on a night MAYA has sent to becomes a
--    manual price at that rate (_shared/pms/pms-edits.ts), so MAYA stops
--    writing over it. rate_updates.confirmed_at says a send is settled: the
--    push stamps it when the vendor reports the send's job applied. Only a
--    settled send an hour old lets a different PMS rate count as the hotel's
--    change; a synchronous vendor's accepted send ("accepted:") needs no
--    stamp. rate_updates.pms_edited_at says when the ledger was brought in
--    step with a rate read in the PMS. manual_price.source ('maya' or 'pms')
--    and manual_price.pms_type say where a manual price came from; a PMS
--    change has no set_by, and set_manual_prices_from_pms writes it with its
--    reset (effects suppressed, pickups retired) in one transaction. The
--    manual_price.set product event stays a price typed in MAYA, and a PMS
--    change is manual_price.changed_in_pms. Sends
--    from before this carry no stamp and are not backfilled: nobody knows
--    which of them applied, so a change on those nights is left alone until
--    MAYA sends to them again.
--
-- Before deploying, run the zero-base check at the end of this file: nights
-- an earlier push opened at the floor while the PMS had them at 0.
--
-- Run AFTER 99_supabase_migration_rate_push_v1.sql,
-- 99_supabase_migration_roles_v2_part2.sql (is_hotel_accessible),
-- 99_supabase_migration_rls_helpers_lockdown_v1.sql (is_platform_admin),
-- 99_supabase_migration_manual_price_v1.sql and
-- 99_supabase_migration_product_events_v1.sql (section 8 replaces its
-- manual_price event triggers).
-- Idempotent. Code deployed ahead of sections 1 and 2 fills calendar gaps
-- only, as before, and logs that the column is missing. Code deployed ahead
-- of section 3 still pushes; recording incidents fails and is logged
-- (rate_push_incident_write_failed) on every run that has a failure. Ahead of
-- section 4, runs are logged without their nights, and a push whose tick's
-- evaluation failed holds back every price whose own row is old. Ahead of
-- section 5, a reconnect's stamp is logged as failed and holds wait their day.
-- Ahead of section 7, each ledger write is refused once and sent again
-- without sent_price, and only sent rows count as known to the calendar.
-- Ahead of section 8, the same retry leaves out confirmed_at and
-- pms_edited_at, no rate changed in the PMS is adopted, a price typed in MAYA
-- is saved without a source, and every manual price reads as typed in MAYA.
--
-- NOT mirrored into 02_supabase_schema.sql yet — fold it in on the next
-- schema consolidation pass.

begin;

alter table public.pms_connections
  add column if not exists base_rates_refreshed_at timestamptz;

comment on column public.pms_connections.base_rates_refreshed_at is
  'Instant of the scheduled tick that last re-read this hotel''s base rates '
  'from the PMS into base_rate_calendar. Throttles the refresh; null = never '
  '(going live clears it, so the first live push prices on a fresh read).';

update public.pms_connections
   set push_rate_targets = null
 where push_rate_targets is not null;

-- 4.
alter table public.evaluation_run_log
  add column if not exists first_stay_date date,
  add column if not exists last_stay_date date;

comment on column public.evaluation_run_log.first_stay_date is
  'First night the run priced. With last_stay_date, the nights the push takes '
  'this run as proof of a current price for; null = none.';
comment on column public.evaluation_run_log.last_stay_date is
  'Last night the run priced (see first_stay_date).';

-- 5.
alter table public.pms_connections
  add column if not exists reauthorized_at timestamptz;

comment on column public.pms_connections.reauthorized_at is
  'When a person last stored a new grant for this connection. Ends a rate push '
  'hold for a missing permission or a refused grant whose last try is older.';

-- 6. Before running, see what this resets and what it leaves frozen:
--
--   select (exists (
--             select 1 from public.rate_updates s
--              where s.hotel_id = u.hotel_id
--                and s.room_type_id = u.room_type_id
--                and s.status in ('sent', 'failed')
--           )) as room_type_was_sent_to,
--          count(*) as skips,
--          count(distinct u.room_type_id) as room_types
--     from public.rate_updates u
--    where u.status = 'skipped'
--      and u.error = 'no rate target for room type'
--      and u.attempts = 1
--      and u.pms_job_reference is null
--      and u.external_rate_id is null
--    group by 1;
--
-- room_type_was_sent_to false is what goes back to attempts 0.
update public.rate_updates u
   set attempts = 0
 where u.status = 'skipped'
   and u.error = 'no rate target for room type'
   and u.attempts = 1
   and u.pms_job_reference is null
   and u.external_rate_id is null
   and not exists (
         select 1
           from public.rate_updates s
          where s.hotel_id = u.hotel_id
            and s.room_type_id = u.room_type_id
            and s.status in ('sent', 'failed')
       );

-- 7.
alter table public.rate_updates
  add column if not exists sent_price numeric(10,2);

comment on column public.rate_updates.sent_price is
  'The price MAYA''s last accepted send left in the PMS for this night: the '
  'price of a sent row, kept by a skipped row over it, null after a refused '
  'or unconfirmed send or when no send is known.';

update public.rate_updates
   set sent_price = price
 where status = 'sent'
   and sent_price is null;

commit;

-- ============================================================================
-- 8. Rates changed in the PMS
-- ============================================================================

begin;

alter table public.rate_updates
  add column if not exists confirmed_at timestamptz,
  add column if not exists pms_edited_at timestamptz;

comment on column public.rate_updates.confirmed_at is
  'When the vendor reported this row''s send applied (its job confirmed). A sent row '
  'with it, or with an "accepted:" reference, is settled: only then can a different '
  'rate in the PMS be taken as the hotel''s own change. Null on every new send.';
comment on column public.rate_updates.pms_edited_at is
  'When the ledger was brought in step with a rate read in the PMS: a change the hotel '
  'made there (adopted as a manual price), or a manual price the PMS already had. '
  'price and sent_price are then that rate. Null on every new send.';

alter table public.manual_price
  add column if not exists source text not null default 'maya',
  add column if not exists pms_type public.pms_type;

alter table public.manual_price drop constraint if exists manual_price_source_chk;
alter table public.manual_price
  add constraint manual_price_source_chk
  check (source in ('maya', 'pms') and ((source = 'pms') = (pms_type is not null)));

comment on column public.manual_price.source is
  '''maya'': typed in MAYA (set_by is the person). ''pms'': a rate the hotel changed in '
  'the PMS on a night MAYA had sent to, kept as a manual price (set_by null, pms_type '
  'says which PMS).';
comment on column public.manual_price.pms_type is
  'The PMS a source ''pms'' price was changed in; null for a price typed in MAYA.';

-- Product events: one save is still one event per (property, room type,
-- save), and a PMS change is its own event, so "manual prices set" stays
-- what people typed.
create or replace function public.product_events_manual_price_set(
  p_hotel_id uuid, p_room_type_id uuid, p_set_at timestamptz, p_set_by uuid, p_source text
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_nights int;
  v_first date;
  v_last date;
  v_event text := case when p_source = 'pms' then 'manual_price.changed_in_pms' else 'manual_price.set' end;
begin
  select count(*), min(mp.stay_date), max(mp.stay_date)
    into v_nights, v_first, v_last
    from public.manual_price mp
   where mp.hotel_id = p_hotel_id
     and mp.room_type_id = p_room_type_id
     and mp.set_at = p_set_at
     and mp.source = p_source
     and mp.cleared_at is null;

  perform public.product_event_emit(
    v_event, p_hotel_id, p_set_by,
    jsonb_build_object(
      'room_type_id', p_room_type_id, 'nights', v_nights,
      'first_night', v_first, 'last_night', v_last,
      'lead_days', v_first - (p_set_at at time zone 'UTC')::date
    ),
    'trigger', p_set_at,
    v_event || ':' || p_hotel_id || ':' || p_room_type_id || ':'
      || to_char(p_set_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS')
  );
end;
$$;

revoke all on function public.product_events_manual_price_set(uuid, uuid, timestamptz, uuid, text) from public, anon, authenticated;

create or replace function public.product_events_manual_price_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
begin
  begin
    for r in
      select n.hotel_id, n.room_type_id, n.set_at, n.source, max(n.set_by::text)::uuid as set_by
        from new_rows n
       where n.cleared_at is null
       group by n.hotel_id, n.room_type_id, n.set_at, n.source
    loop
      perform public.product_events_manual_price_set(r.hotel_id, r.room_type_id, r.set_at, r.set_by, r.source);
    end loop;
  exception when others then
    raise warning 'product_events_manual_price_insert: % [%]', sqlerrm, sqlstate;
  end;
  return null;
end;
$$;

create or replace function public.product_events_manual_price_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
begin
  begin
    for r in
      select n.hotel_id, n.room_type_id, n.set_at, n.source, max(n.set_by::text)::uuid as set_by
        from new_rows n
        join old_rows o using (hotel_id, stay_date, room_type_id)
       where n.cleared_at is null
         and (o.cleared_at is not null or n.set_at is distinct from o.set_at)
       group by n.hotel_id, n.room_type_id, n.set_at, n.source
    loop
      perform public.product_events_manual_price_set(r.hotel_id, r.room_type_id, r.set_at, r.set_by, r.source);
    end loop;

    for r in
      select n.hotel_id, n.room_type_id, n.cleared_at, max(n.cleared_by::text)::uuid as cleared_by,
             count(*) as nights, min(n.stay_date) as first_night, max(n.stay_date) as last_night
        from new_rows n
        join old_rows o using (hotel_id, stay_date, room_type_id)
       where o.cleared_at is null and n.cleared_at is not null
       group by n.hotel_id, n.room_type_id, n.cleared_at
    loop
      perform public.product_event_emit(
        'manual_price.cleared', r.hotel_id, r.cleared_by,
        jsonb_build_object(
          'room_type_id', r.room_type_id, 'nights', r.nights,
          'first_night', r.first_night, 'last_night', r.last_night
        ),
        'trigger', r.cleared_at,
        'manual_price.cleared:' || r.hotel_id || ':' || r.room_type_id || ':'
          || to_char(r.cleared_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS')
      );
    end loop;
  exception when others then
    raise warning 'product_events_manual_price_update: % [%]', sqlerrm, sqlstate;
  end;
  return null;
end;
$$;

-- The triggers now call the five-argument function; the old one has no caller.
drop function if exists public.product_events_manual_price_set(uuid, uuid, timestamptz, uuid);

drop trigger if exists trg_product_events_manual_price_insert on public.manual_price;
create trigger trg_product_events_manual_price_insert
  after insert on public.manual_price
  referencing new table as new_rows
  for each statement execute function public.product_events_manual_price_insert();

drop trigger if exists trg_product_events_manual_price_update on public.manual_price;
create trigger trg_product_events_manual_price_update
  after update on public.manual_price
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.product_events_manual_price_update();

-- A rate changed in the PMS becomes a manual price in one transaction: the
-- rows, the ladder effects already holding on those cells suppressed, and
-- their open pickup events retired, exactly as setManualPrices does for a
-- price typed in MAYA (_shared/pms/manual-price.ts). Written in steps, a
-- failure after the rows left an open manual price with its effects still
-- applying, and the same tick published and sent the hotel's rate plus those
-- effects over the hotel's own. The next read then found MAYA's price there
-- and never took the change again. p_cells is a JSON array of
-- {room_type_id, stay_date, price}; each cell once.
create or replace function public.set_manual_prices_from_pms(
  p_hotel_id uuid,
  p_pms_type public.pms_type,
  p_set_at timestamptz,
  p_cells jsonb
) returns table (cells integer, suppressed_rules integer, retired_pickups integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cells integer;
  v_rules integer;
  v_pickups integer;
begin
  insert into public.manual_price as mp
    (hotel_id, stay_date, room_type_id, price, note, set_by, set_at, cleared_at, cleared_by, source, pms_type)
  select distinct on (c.room_type_id, c.stay_date)
         p_hotel_id, c.stay_date, c.room_type_id, c.price, null, null, p_set_at, null, null, 'pms', p_pms_type
    from jsonb_to_recordset(p_cells) as c(room_type_id uuid, stay_date date, price numeric)
  on conflict (hotel_id, stay_date, room_type_id) do update
     set price = excluded.price,
         note = null,
         set_by = null,
         set_at = excluded.set_at,
         cleared_at = null,
         cleared_by = null,
         source = 'pms',
         pms_type = excluded.pms_type;
  get diagnostics v_cells = row_count;

  update public.ladder_rule_state s
     set suppressed_at = p_set_at
   where s.rule_id in (select r.id from public.pricing_rules r where r.hotel_id = p_hotel_id)
     and (s.room_type_id, s.stay_date) in (
           select c.room_type_id, c.stay_date
             from jsonb_to_recordset(p_cells) as c(room_type_id uuid, stay_date date))
     and s.is_active
     and s.suppressed_at is null;
  get diagnostics v_rules = row_count;

  update public.pickup_event e
     set retired_at = p_set_at
   where e.hotel_id = p_hotel_id
     and (e.affected_room_type_id, e.stay_date) in (
           select c.room_type_id, c.stay_date
             from jsonb_to_recordset(p_cells) as c(room_type_id uuid, stay_date date))
     and e.retired_at is null;
  get diagnostics v_pickups = row_count;

  return query select v_cells, v_rules, v_pickups;
end;
$$;

revoke all on function public.set_manual_prices_from_pms(uuid, public.pms_type, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.set_manual_prices_from_pms(uuid, public.pms_type, timestamptz, jsonb) to service_role;

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
-- Deleting a hotel cascades here; the indexes above are partial.
create index if not exists idx_rate_push_incidents_hotel
  on public.rate_push_incidents (hotel_id);

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
-- Deleting a hotel or a room type cascades here.
create index if not exists idx_rate_push_incident_cells_hotel
  on public.rate_push_incident_cells (hotel_id);
create index if not exists idx_rate_push_incident_cells_room_type
  on public.rate_push_incident_cells (room_type_id);

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
-- Deleting a hotel or a room type cascades here.
create index if not exists idx_rate_push_attempts_hotel
  on public.rate_push_attempts (hotel_id);
create index if not exists idx_rate_push_attempts_room_type
  on public.rate_push_attempts (room_type_id);

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
  -- updated_at is left alone: it is the push's last write, which the close
  -- below waits on, and an incident whose last cells were stopped here closes
  -- in this same pass.
  update public.rate_push_incidents i
     set cells_stopped = i.cells_stopped + n.cells
    from (select incident_id, count(*)::integer as cells from stopped group by incident_id) n
   where i.id = n.incident_id;

  -- Open incidents with nothing left open. Same tie order as the code
  -- (resolutionOf): landed, then superseded, then stopped. Left alone for ten
  -- minutes after a push's write, so a push writing a new incident before its
  -- cells is never closed under it.
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
--
-- Zero-base check, before deploying. Nights of live hotels where MAYA's rate
-- is in the PMS while the hotel's own rate for the night was 0 (closed, or
-- not loaded) and nobody typed a price: the old engine priced such a night at
-- the floor and the push opened it. The new engine stops pricing these
-- nights, keeps the row so it still shows, and the push files each one for
-- admins as guardrail_zero_base. Anything listed here is worth a word with
-- the hotel: close the night in the PMS, or load its rate.
--
--   select h.name as hotel, rt.name as room_type, u.stay_date, u.price, u.pushed_at
--     from public.rate_updates u
--     join public.base_rate_calendar b
--       on b.hotel_id = u.hotel_id and b.room_type_id = u.room_type_id and b.stay_date = u.stay_date
--     join public.hotel_settings s on s.hotel_id = u.hotel_id and s.simulation_mode = false
--     join public.hotels h on h.id = u.hotel_id
--     join public.room_types rt on rt.id = u.room_type_id
--    where u.status = 'sent'
--      and b.price = 0
--      and u.stay_date >= current_date
--      and not exists (
--        select 1 from public.manual_price m
--         where m.hotel_id = u.hotel_id and m.room_type_id = u.room_type_id
--           and m.stay_date = u.stay_date and m.cleared_at is null
--      )
--    order by h.name, rt.name, u.stay_date;
