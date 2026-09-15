-- ============================================================================
-- MANUAL PRICE — a human-typed rate for one (stay_date, room_type) cell
-- ============================================================================
--
-- A hotelier types a number for a night and MAYA publishes that number. It is
-- a RESET POINT for the cell, not a nudge on top of what MAYA was doing:
--
--   * The typed price becomes the cell's base, ahead of the property's own
--     base_rate_calendar rate. It has to sit in the top precedence slot,
--     because the scheduled tick re-resolves every base from scratch every
--     five minutes and anything lower down is silently outranked or
--     overwritten before it ever reaches the PMS.
--   * Every rule effect that was ALREADY holding on the cell is suppressed
--     (ladder rows get suppressed_at set; pickup events are retired) so the
--     published price is the typed number and nothing else.
--   * A rule that fires AFTER the override applies on top of the typed
--     number, which is the cell's base from then on.
--   * Clearing restores MAYA's own pricing: the base falls through to
--     calendar > reservation > remembered, and the suppression is lifted the
--     next time each rule transitions.
--
-- Why a separate table and not base_rate_calendar with source='manual': that
-- table holds the rate the PROPERTY set, read from the PMS before we ever
-- touched the cell, and "clear" needs it intact to restore to. Writing a
-- human number over it would erase the very thing clear falls back to, and
-- the calendar seeder's coverage probe (a bare MAX(stay_date)) would be
-- poisoned by a far-future manual row.
--
-- Rows are never deleted. Set = upsert with cleared_at null; clear = stamp
-- cleared_at / cleared_by. The row stays as the audit trail of who typed what.
--
-- Run AFTER 99_supabase_migration_roles_v2_part2.sql (is_hotel_accessible and
-- can_manage_hotel) and 99_supabase_migration_realtime_v1.sql (the
-- supabase_realtime publication). Idempotent.
--
-- NOT mirrored into 02_supabase_schema.sql yet — fold it in on the next
-- schema consolidation pass, like base_rate_calendar.

begin;

create table if not exists manual_price (
  hotel_id     uuid not null references hotels(id) on delete cascade,
  stay_date    date not null,
  room_type_id uuid not null references room_types(id) on delete cascade,
  price        numeric(10,2) not null check (price >= 0),
  set_by       uuid references auth.users(id) on delete set null,
  set_at       timestamptz not null default now(),
  cleared_at   timestamptz,
  cleared_by   uuid references auth.users(id) on delete set null,
  note         text,
  primary key (hotel_id, stay_date, room_type_id)
);

-- The engine reads only open overrides, a whole horizon at a time.
create index if not exists idx_manual_price_open
  on manual_price (hotel_id, stay_date)
  where cleared_at is null;

alter table manual_price enable row level security;

-- Anyone on the hotel can see what was typed. Writing goes through
-- /api/manual-price only (service role, after the can_manage_hotel gate):
-- the route is what validates floor/ceiling and past dates, stamps set_by
-- with the real caller, and suppresses the rules already holding on the
-- cell. A direct PostgREST write would skip all of that and could put any
-- teammate's id on the row, so members get no write grant at all.
drop policy if exists manual_price_select on manual_price;
create policy manual_price_select
  on manual_price for select
  using (public.is_hotel_accessible(hotel_id));

-- Earlier cut of this migration granted these; harmless when absent.
drop policy if exists manual_price_insert on manual_price;
drop policy if exists manual_price_update on manual_price;
revoke insert, update, delete on manual_price from authenticated;

grant select on manual_price to authenticated;
grant all on manual_price to service_role;

-- An active ladder row that was already applying when the override landed
-- keeps is_active = true (the condition still holds, and the rule must not
-- re-fire on the same trigger) but stops contributing to the price. The
-- engine clears this on the row's next activate/deactivate transition.
alter table ladder_rule_state
  add column if not exists suppressed_at timestamptz;

-- Realtime: the dashboard's live subscription watches for set/clear so the
-- day card updates without a reload. Same guard as realtime_v1.
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
      and tablename = 'manual_price'
  ) then
    alter publication supabase_realtime add table public.manual_price;
  end if;
end
$$;

commit;
