-- ============================================================================
-- MAYA: what the property system changes about the property itself, v1
-- ============================================================================
--
-- Audit A16 and the pilots' time zones (Jake, 2026-09-30 and 2026-10-01).
--
-- A room type deleted or replaced in Cloudbeds stayed active in MAYA for
-- good: priced, counted in every occupancy denominator and billed. A hotel
-- that replaced "Standard" (10 rooms) with "Standard King" (6) and "Standard
-- Queen" (4) ran 20 rooms in MAYA for 10 real ones. And the time zone and
-- currency were read once, at connect, and never again: both pilots kept UTC
-- because the read looked for the time zone where Cloudbeds does not put it.
--
-- What this file adds:
--
--   1. room_types.pms_removed_at: when a complete read of the property
--      system's room types stopped listing this one. The type is switched
--      off (is_active false), which takes it out of pricing, occupancy, the
--      rules' room type sets and the billed room count, everywhere at once.
--      Nothing is deleted: the row, its history and its rules' links stay.
--      Null on every type that is listed, and on a type someone switched off
--      by hand, which a read never turns back on.
--
--   2. pms_property_changes: the change log's lines about the property
--      itself, found by a read of the property system. Members read their
--      own property's rows; only the service role writes.
--        room_type_removed  the type is no longer listed, and MAYA switched
--                           it off (room_type_id, room_type_name)
--        room_type_back     it is listed again, and MAYA switched it back on
--        timezone           the hotel's time zone changed to the system's
--                           (before_value, after_value)
--        currency           the hotel's currency changed to the system's,
--                           only ever on a property in simulation
--
--   3. pms_room_types_reconcile(hotel, pms, listed, remove): what the sync
--      calls BEFORE it writes the room types it read, with the ids it read.
--        - a type switched off this way that is listed again comes back on
--          (any read: being listed proves it is there);
--        - with remove true (the sync passes it only for a full read whose
--          list was complete, see cloudbeds/sync-hotel.ts), every active type
--          not listed is switched off;
--        - unless nothing the property had is in the list at all: that looks
--          far more like a wrong answer (another property, new ids) than a
--          property that replaced every room type at once, so nothing is
--          switched off and those types come back as 'kept' for the sync to
--          raise with MAYA staff.
--      Each change writes its change log line in the same transaction.
--      Returns (change, room_type_id, room_type_name) per type: 'back',
--      'removed' or 'kept'.
--
--   4. pms_property_details_refresh(hotel, pms, timezone, currency): what the
--      sync calls once a day with the time zone and currency the property
--      system reports. A missing value never replaces a stored one, and a
--      time zone Postgres does not know is ignored. A changed time zone is
--      saved with its change log line. A changed currency is saved, with its
--      line, only while the property is in simulation; on a live property it
--      is NOT changed (its floors, ceilings and every price sent are in the
--      currency it has) and comes back as 'currency_kept' for the sync to
--      raise with MAYA staff. Returns (change, before_value, after_value).
--
--   5. Room types' display_name, for properties on Cloudbeds: it held
--      Cloudbeds' short code (roomTypeNameShort, "DBL"), which two different
--      types can share. It is set to the full name once here; the sync now
--      writes the full name on every read.
--
-- Both functions run as the caller (security invoker) and only the service
-- role may call them.
--
-- The app and the edge functions work before this file runs: they read the
-- missing column or function as "not yet", log it, and switch nothing off.
--
-- The PGlite test runs this file twice (pms-property-changes-migration-sql.test.ts).
-- Safe to run more than once: the column and table are added only when
-- missing, every check is dropped and made again, functions are replaced, and
-- the display name fix finds nothing left to fix the second time.

begin;

-- ── 1. A room type the property system no longer lists ─────────────────────

alter table public.room_types add column if not exists pms_removed_at timestamptz;

comment on column public.room_types.pms_removed_at is
  'When a complete read of the property system stopped listing this room type and MAYA switched it off '
  '(is_active false). Null while it is listed, and on a type switched off by hand. Cleared, and the type '
  'switched back on, when a read lists it again (pms_room_types_reconcile).';

-- ── 2. The change log's lines ─────────────────────────────────────────────

create table if not exists public.pms_property_changes (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  pms_type public.pms_type not null,
  kind text not null,
  found_at timestamptz not null default now(),
  room_type_id uuid references public.room_types(id) on delete cascade,
  room_type_name text,
  before_value text,
  after_value text
);

alter table public.pms_property_changes drop constraint if exists pms_property_changes_kind_check;
alter table public.pms_property_changes add constraint pms_property_changes_kind_check
  check (kind in ('room_type_removed', 'room_type_back', 'timezone', 'currency'));

alter table public.pms_property_changes drop constraint if exists pms_property_changes_shape_check;
alter table public.pms_property_changes add constraint pms_property_changes_shape_check
  check (
    (kind in ('room_type_removed', 'room_type_back')
      and room_type_id is not null and room_type_name is not null
      and before_value is null and after_value is null)
    or (kind in ('timezone', 'currency')
      and after_value is not null
      and room_type_id is null and room_type_name is null)
  );

create index if not exists idx_pms_property_changes_hotel_found
  on public.pms_property_changes (hotel_id, found_at desc);

comment on table public.pms_property_changes is
  'Change log lines about the property itself, found by a read of its property system: a room type it no '
  'longer lists (switched off) or lists again (switched back on), and the time zone or currency changed to '
  'the system''s. Written by pms_room_types_reconcile and pms_property_details_refresh.';

alter table public.pms_property_changes enable row level security;

revoke all on public.pms_property_changes from public, anon, authenticated, service_role;
grant select on public.pms_property_changes to authenticated;
grant select, insert, update, delete on public.pms_property_changes to service_role;

drop policy if exists pms_property_changes_read on public.pms_property_changes;
create policy pms_property_changes_read on public.pms_property_changes
  for select using (public.is_hotel_accessible(hotel_id));

-- ── 3. Switching room types off and back on ───────────────────────────────

create or replace function public.pms_room_types_reconcile(
  p_hotel_id uuid,
  p_pms_type public.pms_type,
  p_listed text[],
  p_remove boolean
)
returns table (change text, room_type_id uuid, room_type_name text)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  r record;
begin
  if p_hotel_id is null or p_pms_type is null or p_listed is null then
    return;
  end if;

  -- Listed again. Only a type this function switched off comes back on.
  for r in
    update public.room_types rt
       set is_active = true, pms_removed_at = null, updated_at = now()
     where rt.hotel_id = p_hotel_id
       and rt.pms_removed_at is not null
       and rt.external_room_type_id = any (p_listed)
    returning rt.id, rt.name
  loop
    insert into public.pms_property_changes (hotel_id, pms_type, kind, room_type_id, room_type_name)
    values (p_hotel_id, p_pms_type, 'room_type_back', r.id, r.name);
    change := 'back';
    room_type_id := r.id;
    room_type_name := r.name;
    return next;
  end loop;

  if not coalesce(p_remove, false) or cardinality(p_listed) = 0 then
    return;
  end if;

  -- Nothing the property had is in the list: kept, and said.
  if not exists (
    select 1 from public.room_types rt
     where rt.hotel_id = p_hotel_id
       and rt.is_active
       and rt.external_room_type_id = any (p_listed)
  ) then
    for r in
      select rt.id, rt.name from public.room_types rt
       where rt.hotel_id = p_hotel_id
         and rt.is_active
       order by rt.name
    loop
      change := 'kept';
      room_type_id := r.id;
      room_type_name := r.name;
      return next;
    end loop;
    return;
  end if;

  for r in
    update public.room_types rt
       set is_active = false, pms_removed_at = now(), updated_at = now()
     where rt.hotel_id = p_hotel_id
       and rt.is_active
       and not (rt.external_room_type_id = any (p_listed))
    returning rt.id, rt.name
  loop
    insert into public.pms_property_changes (hotel_id, pms_type, kind, room_type_id, room_type_name)
    values (p_hotel_id, p_pms_type, 'room_type_removed', r.id, r.name);
    change := 'removed';
    room_type_id := r.id;
    room_type_name := r.name;
    return next;
  end loop;
end;
$$;

comment on function public.pms_room_types_reconcile(uuid, public.pms_type, text[], boolean) is
  'Called by the scheduled sync before it writes the room types it read: a type switched off for not being '
  'listed comes back on when listed again; with p_remove (a full read with a complete list) every active type '
  'not listed is switched off, unless none of the property''s active types is listed (returned as kept). '
  'Writes the change log line for each. Service role only.';

revoke all on function public.pms_room_types_reconcile(uuid, public.pms_type, text[], boolean) from public, anon, authenticated;
grant execute on function public.pms_room_types_reconcile(uuid, public.pms_type, text[], boolean) to service_role;

-- ── 4. The time zone and currency, once a day ─────────────────────────────

create or replace function public.pms_property_details_refresh(
  p_hotel_id uuid,
  p_pms_type public.pms_type,
  p_timezone text,
  p_currency text
)
returns table (change text, before_value text, after_value text)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_tz text;
  v_cur text;
  v_new_tz text := nullif(btrim(coalesce(p_timezone, '')), '');
  v_new_cur text := upper(nullif(btrim(coalesce(p_currency, '')), ''));
begin
  if p_hotel_id is null or p_pms_type is null then
    return;
  end if;

  select h.timezone, h.currency into v_tz, v_cur
    from public.hotels h
   where h.id = p_hotel_id
     for update;
  if not found then
    return;
  end if;

  if v_new_tz is not null and v_new_tz is distinct from v_tz
     and exists (select 1 from pg_catalog.pg_timezone_names z where z.name = v_new_tz) then
    update public.hotels set timezone = v_new_tz where id = p_hotel_id;
    insert into public.pms_property_changes (hotel_id, pms_type, kind, before_value, after_value)
    values (p_hotel_id, p_pms_type, 'timezone', v_tz, v_new_tz);
    change := 'timezone';
    before_value := v_tz;
    after_value := v_new_tz;
    return next;
  end if;

  if v_new_cur is not null and v_new_cur is distinct from upper(coalesce(v_cur, '')) then
    if exists (
      select 1 from public.hotel_settings s
       where s.hotel_id = p_hotel_id
         and s.simulation_mode = false
    ) then
      change := 'currency_kept';
    else
      update public.hotels set currency = v_new_cur where id = p_hotel_id;
      insert into public.pms_property_changes (hotel_id, pms_type, kind, before_value, after_value)
      values (p_hotel_id, p_pms_type, 'currency', v_cur, v_new_cur);
      change := 'currency';
    end if;
    before_value := v_cur;
    after_value := v_new_cur;
    return next;
  end if;
end;
$$;

comment on function public.pms_property_details_refresh(uuid, public.pms_type, text, text) is
  'Called by the scheduled sync once a day with the time zone and currency the property system reports. '
  'A missing value or an unknown time zone changes nothing. A changed time zone is saved with its change '
  'log line; a changed currency only while the property is in simulation, and on a live property comes '
  'back as currency_kept. Service role only.';

revoke all on function public.pms_property_details_refresh(uuid, public.pms_type, text, text) from public, anon, authenticated;
grant execute on function public.pms_property_details_refresh(uuid, public.pms_type, text, text) to service_role;

-- ── 5. Full room type names on Cloudbeds properties ───────────────────────

update public.room_types rt
   set display_name = rt.name
  from public.pms_connections c
 where c.hotel_id = rt.hotel_id
   and c.pms_type = 'cloudbeds'
   and rt.display_name is distinct from rt.name;

commit;

-- Check afterwards:
--
--   -- The column, the table and both functions are there:
--   select column_name from information_schema.columns
--    where table_schema = 'public' and table_name = 'room_types' and column_name = 'pms_removed_at';
--   select to_regclass('public.pms_property_changes');
--   select p.proname, has_function_privilege('authenticated', p.oid, 'execute') as authenticated
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname in ('pms_room_types_reconcile', 'pms_property_details_refresh');
--   -- (two rows, authenticated false on both)
--
--   -- No Cloudbeds room type shows a short code any more:
--   select h.name, rt.name, rt.display_name
--     from public.room_types rt
--     join public.hotels h on h.id = rt.hotel_id
--     join public.pms_connections c on c.hotel_id = rt.hotel_id and c.pms_type = 'cloudbeds'
--    where rt.display_name is distinct from rt.name;  -- no rows
--
--   -- After the next daily read, each property's time zone and anything switched off:
--   select h.name, x.kind, x.found_at, x.room_type_name, x.before_value, x.after_value
--     from public.pms_property_changes x join public.hotels h on h.id = x.hotel_id
--    order by x.found_at desc;
