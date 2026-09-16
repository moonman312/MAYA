-- ============================================================================
-- ROOMS OUT OF SERVICE — "3 of the 12 Kings are being renovated until March"
-- ============================================================================
--
-- snapshots write sellable_units = room_types.total_rooms for every stay
-- date, which is the size of the building, not the size of what can be sold.
-- A wing under renovation, a room with a burst pipe, a floor held back for a
-- crew: every one of those makes MAYA read occupancy lower than it is and
-- price a nearly-full house as if it were half empty.
--
-- No PMS exposes this consistently, and the ones that do need another OAuth
-- scope for it, so this is a small manual table: a room type, a date range,
-- a unit count. The snapshot subtracts the open rows' units from
-- total_rooms for each night in range (floored at zero), and everything
-- downstream reads the smaller number. Wherever the product explains
-- occupancy it now says "sellable occupancy", because that is what it is.
--
-- Rows are never deleted by the app. Clearing stamps cleared_at / cleared_by
-- and the row stays as the record of what was taken out and by whom, same
-- pattern as manual_price.
--
-- Run AFTER 99_supabase_migration_room_type_counts_as_room_v1.sql (ordering
-- only; nothing here depends on that column). Idempotent. Code deployed
-- ahead of this file treats the table as empty and logs that it did so.
--
-- NOT mirrored into 02_supabase_schema.sql yet — fold it in on the next
-- schema consolidation pass.

begin;

create table if not exists room_type_out_of_service (
  id           uuid primary key default gen_random_uuid(),
  hotel_id     uuid not null references hotels(id) on delete cascade,
  room_type_id uuid not null references room_types(id) on delete cascade,
  start_date   date not null,
  end_date     date not null,
  units        integer not null,
  reason       text,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  cleared_at   timestamptz,
  cleared_by   uuid references auth.users(id) on delete set null,
  check (end_date >= start_date),
  check (units > 0)
);

comment on table room_type_out_of_service is
  'Units of a room type that cannot be sold for a date range (renovation, maintenance). Subtracted from stay_date_snapshot.sellable_units. Cleared rows are kept as the audit trail.';

-- The snapshot asks "what is out of service on this hotel across this
-- horizon" in one query; only open rows matter to it.
create index if not exists idx_room_type_out_of_service_open
  on room_type_out_of_service (hotel_id, start_date, end_date)
  where cleared_at is null;

alter table room_type_out_of_service enable row level security;

-- Anyone on the hotel can see what is out. Writing goes through the API
-- route only (service role, after its own rank check): the route is what
-- refuses a unit count larger than the type, stamps created_by with the real
-- caller, and can trigger a re-snapshot. A direct PostgREST write would skip
-- all of that and could put any teammate's id on the row, so members get no
-- write grant at all — same shape as manual_price.
drop policy if exists room_type_out_of_service_select on room_type_out_of_service;
create policy room_type_out_of_service_select
  on room_type_out_of_service for select
  using (public.is_hotel_accessible(hotel_id));

revoke insert, update, delete on room_type_out_of_service from authenticated;
grant select on room_type_out_of_service to authenticated;
grant all on room_type_out_of_service to service_role;

-- Realtime: the dashboard's live subscription refreshes the day cards when a
-- block is added or cleared. Same guard as realtime_v1.
do $$
begin
  if not exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) then
    create publication supabase_realtime;
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'room_type_out_of_service'
  ) then
    alter publication supabase_realtime add table public.room_type_out_of_service;
  end if;
end
$$;

commit;
