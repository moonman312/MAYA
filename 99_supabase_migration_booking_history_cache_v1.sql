-- ============================================================================
-- MAYA booking history kept for the hotel day (v1)
-- ============================================================================
--
-- Decided by Jake on 2026-09-29: the rule activation popup gets faster by
-- reusing the comparison data (not by checking while the rule builder is
-- filled in, and not, for now, by filling the calendar in bit by bit).
--
-- A booking speed reading compares a night's bookings with what similar
-- nights usually got. That "usual" is worked out from the hotel's booking
-- history: a per-date summary over the last three years (the season model's
-- input, booking_speed_history_summary) and the grouped booking windows of
-- the dates each night is compared with (booking_speed_windows). Both are
-- read from every reservation the hotel has had, and until now they were
-- read again by every run: every scheduled tick, and the activation popup
-- twice per part (the hotel with the rule and without), three parts at once.
--
-- For a hotel day that history does not change unless the PMS changes a
-- booking on a night that is already over: the stretches counted are whole
-- hotel days. So the engine now keeps it here, per hotel and hotel day,
-- and reads it back while it is still exactly the history in the table:
--
--   1. booking_history_seq: one number per hotel, moved by the triggers
--      below whenever a reservation on a night up to tomorrow (UTC; every
--      hotel's "nights already over" are before that) is added, removed, or
--      changed in anything the history reads (its hotel, night, room type,
--      booking date, booking window or PMS id). A booking on a night ahead
--      moves nothing: those nights are never kept.
--   2. booking_history_cache: what a scheduled run read, under the number it
--      read first. Keyed by hotel, hotel date and a key naming what it holds
--      and everything that depends on (the room types left out or measured,
--      the first night of the history, the capacity milestones, a format
--      number). Only nights already over are kept: the summary rows up to
--      yesterday, the windows of past dates, a set's first stay date when
--      that is in the past.
--   3. booking_history_cache_get(): the entries asked for, only when kept
--      under the hotel's current number, and the number. The popup and the
--      scheduled runs read it; nothing else about a night is read from here.
--   4. booking_history_cache_put(): saves entries read under a number, only
--      when that number is still current (a booking on a past night that
--      changed in between leaves them unsaved), merging a key's nights with
--      those already kept under the same number. Drops the hotel's entries
--      of older days and older numbers.
--
-- Nothing here is customer data: it is a copy of what the booking tables
-- already hold, dropped after a day. Closed periods and the owner's "not a
-- fair comparison" dates are not kept (each run reads them).
--
-- Deploy order: 1. run this file; 2. deploy the edge functions (each sync
-- function, for the engine copy); 3. deploy the app. Either engine without
-- the file reads the history afresh, as before, and says so once in its log.
--
-- Safe to run more than once. One transaction.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. booking_history_seq
-- ----------------------------------------------------------------------------

create table if not exists public.booking_history_seq (
  hotel_id   uuid primary key references public.hotels(id) on delete cascade,
  seq        bigint not null default 0,
  changed_at timestamptz not null default now()
);

comment on table public.booking_history_seq is
  'Per hotel, a number moved whenever a reservation on a night already over '
  '(or up to tomorrow, UTC) is added, removed or changed in a column the booking '
  'history reads. No row reads as 0. See 99_supabase_migration_booking_history_cache_v1.sql.';

alter table public.booking_history_seq enable row level security;
revoke all on table public.booking_history_seq from public, anon, authenticated;
grant select, insert, update, delete on table public.booking_history_seq to service_role;

-- ----------------------------------------------------------------------------
-- 2. booking_history_cache
-- ----------------------------------------------------------------------------

create table if not exists public.booking_history_cache (
  hotel_id    uuid not null references public.hotels(id) on delete cascade,
  hotel_date  date not null,
  cache_key   text not null,
  -- Room type lists make keys long; the primary key is on their hash, and
  -- every read compares the key itself too.
  key_hash    text generated always as (md5(cache_key)) stored,
  history_seq bigint not null,
  entries     jsonb not null,
  written_at  timestamptz not null default now(),
  primary key (hotel_id, hotel_date, key_hash)
);

comment on table public.booking_history_cache is
  'The booking history booking speed compares with, as a scheduled run read it '
  'for a hotel day: the summary up to yesterday, past dates'' booking windows, a '
  'set''s first stay date. Read only under the hotel''s current booking_history_seq. '
  'See 99_supabase_migration_booking_history_cache_v1.sql.';
comment on column public.booking_history_cache.history_seq is
  'booking_history_seq.seq when the entries were read: they hold only while it is current.';

create index if not exists booking_history_cache_hotel_date_idx on public.booking_history_cache (hotel_date);

alter table public.booking_history_cache enable row level security;
revoke all on table public.booking_history_cache from public, anon, authenticated;
grant select, insert, update, delete on table public.booking_history_cache to service_role;

-- ----------------------------------------------------------------------------
-- 3. Triggers on reservations
-- ----------------------------------------------------------------------------
--
-- One trigger per event (a trigger with transition tables takes one event),
-- as the pricing cadence's are. The cut-off is tomorrow in UTC: the last
-- night any hotel's history holds is its yesterday, never later than today
-- in UTC, and a day of margin covers a transaction that began before
-- midnight. A night past it is never kept, so a booking there moves nothing.

create or replace function public.booking_history_bump(p_hotel_ids uuid[])
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.booking_history_seq as s (hotel_id, seq, changed_at)
  select distinct h, 1, now()
    from unnest(p_hotel_ids) h
    join public.hotels ho on ho.id = h
  on conflict (hotel_id) do update set seq = s.seq + 1, changed_at = now();
$$;

revoke all on function public.booking_history_bump(uuid[]) from public, anon, authenticated;

create or replace function public.booking_history_reservations_ins()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.booking_history_bump(array_agg(distinct n.hotel_id))
    from new_rows n
   where n.hotel_id is not null
     and n.stay_date < (now() at time zone 'utc')::date + 2
  having count(*) > 0;
  return null;
end;
$$;

create or replace function public.booking_history_reservations_upd()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.booking_history_bump(array_agg(distinct c.hotel_id))
    from (
      select o.hotel_id
        from old_rows o full join new_rows n on n.id = o.id
       where (o.stay_date < (now() at time zone 'utc')::date + 2 or n.stay_date < (now() at time zone 'utc')::date + 2)
         and (o.id is null or n.id is null
              or (o.hotel_id, o.stay_date, o.room_type_id, o.booking_date, o.booking_window_days, o.external_reservation_id)
                 is distinct from
                 (n.hotel_id, n.stay_date, n.room_type_id, n.booking_date, n.booking_window_days, n.external_reservation_id))
      union
      select n.hotel_id
        from old_rows o full join new_rows n on n.id = o.id
       where (o.stay_date < (now() at time zone 'utc')::date + 2 or n.stay_date < (now() at time zone 'utc')::date + 2)
         and (o.id is null or n.id is null
              or (o.hotel_id, o.stay_date, o.room_type_id, o.booking_date, o.booking_window_days, o.external_reservation_id)
                 is distinct from
                 (n.hotel_id, n.stay_date, n.room_type_id, n.booking_date, n.booking_window_days, n.external_reservation_id))
    ) c
   where c.hotel_id is not null
  having count(*) > 0;
  return null;
end;
$$;

create or replace function public.booking_history_reservations_del()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.booking_history_bump(array_agg(distinct o.hotel_id))
    from old_rows o
   where o.hotel_id is not null
     and o.stay_date < (now() at time zone 'utc')::date + 2
  having count(*) > 0;
  return null;
end;
$$;

-- A reservations table emptied in one go takes every hotel's kept history with it.
create or replace function public.booking_history_reservations_truncate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.booking_history_cache;
  return null;
end;
$$;

revoke all on function public.booking_history_reservations_ins() from public, anon, authenticated;
revoke all on function public.booking_history_reservations_upd() from public, anon, authenticated;
revoke all on function public.booking_history_reservations_del() from public, anon, authenticated;
revoke all on function public.booking_history_reservations_truncate() from public, anon, authenticated;

drop trigger if exists trg_booking_history_reservations_ins on public.reservations;
create trigger trg_booking_history_reservations_ins
  after insert on public.reservations
  referencing new table as new_rows
  for each statement execute function public.booking_history_reservations_ins();

drop trigger if exists trg_booking_history_reservations_upd on public.reservations;
create trigger trg_booking_history_reservations_upd
  after update on public.reservations
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.booking_history_reservations_upd();

drop trigger if exists trg_booking_history_reservations_del on public.reservations;
create trigger trg_booking_history_reservations_del
  after delete on public.reservations
  referencing old table as old_rows
  for each statement execute function public.booking_history_reservations_del();

drop trigger if exists trg_booking_history_reservations_truncate on public.reservations;
create trigger trg_booking_history_reservations_truncate
  after truncate on public.reservations
  for each statement execute function public.booking_history_reservations_truncate();

-- ----------------------------------------------------------------------------
-- 4. Reading and saving
-- ----------------------------------------------------------------------------

-- The entries kept for p_keys on the hotel day, only under the hotel's
-- current number; a key's dated entries narrowed to p_dates when given (its
-- other entries, "rows" and "first", always come). Returns
-- {"seq": <current number>, "entries": {key: {...}}}: a key with nothing
-- kept under the current number is left out.
create or replace function public.booking_history_cache_get(
  p_hotel_id uuid,
  p_hotel_date date,
  p_keys text[],
  p_dates date[] default null
)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  with cur as (
    select coalesce((select s.seq from public.booking_history_seq s where s.hotel_id = p_hotel_id), 0) as seq
  )
  select jsonb_build_object(
    'seq', cur.seq,
    'entries', coalesce((
      select jsonb_object_agg(c.cache_key, (
        select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
          from jsonb_each(c.entries) e
         where p_dates is null
            or e.key !~ '^\d{4}-\d{2}-\d{2}$'
            or e.key = any (p_dates::text[])
      ))
        from public.booking_history_cache c
       where c.hotel_id = p_hotel_id
         and c.hotel_date = p_hotel_date
         and c.key_hash in (select md5(k) from unnest(coalesce(p_keys, '{}'::text[])) k)
         and c.cache_key = any (coalesce(p_keys, '{}'::text[]))
         and c.history_seq = cur.seq
    ), '{}'::jsonb)
  )
  from cur;
$$;

-- Saves p_entries ({key: {...}}) for the hotel day, read under p_seq. Does
-- nothing when p_seq is no longer the hotel's number. A key already kept
-- under the same number gets these entries merged into it (a later run read
-- more nights); under another number it is replaced. The hotel's entries of
-- days before yesterday and of older numbers go, and anyone's older than a
-- week. Returns how many keys were written.
create or replace function public.booking_history_cache_put(
  p_hotel_id uuid,
  p_hotel_date date,
  p_seq bigint,
  p_entries jsonb
)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_seq bigint;
  v_n integer := 0;
begin
  select coalesce((select s.seq from public.booking_history_seq s where s.hotel_id = p_hotel_id), 0) into v_seq;
  if p_seq is null or v_seq <> p_seq or p_hotel_date is null then
    return 0;
  end if;

  delete from public.booking_history_cache c
   where c.hotel_id = p_hotel_id
     and (c.hotel_date < p_hotel_date - 1 or c.history_seq <> v_seq);
  delete from public.booking_history_cache c
   where c.hotel_date < p_hotel_date - 7;

  if p_entries is null or jsonb_typeof(p_entries) <> 'object' then
    return 0;
  end if;

  insert into public.booking_history_cache as c (hotel_id, hotel_date, cache_key, history_seq, entries, written_at)
  select p_hotel_id, p_hotel_date, e.key, v_seq, e.value, now()
    from jsonb_each(p_entries) e
   where jsonb_typeof(e.value) = 'object'
  on conflict (hotel_id, hotel_date, key_hash) do update
     set entries = case
                     when c.history_seq = excluded.history_seq and c.cache_key = excluded.cache_key
                       then c.entries || excluded.entries
                     else excluded.entries
                   end,
         cache_key = excluded.cache_key,
         history_seq = excluded.history_seq,
         written_at = now();
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.booking_history_cache_get(uuid, date, text[], date[]) from public, anon, authenticated;
grant execute on function public.booking_history_cache_get(uuid, date, text[], date[]) to service_role;
revoke all on function public.booking_history_cache_put(uuid, date, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.booking_history_cache_put(uuid, date, bigint, jsonb) to service_role;

commit;
