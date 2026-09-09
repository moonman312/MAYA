-- ============================================================================
-- BASE RATE CALENDAR — the hotel's own rate, remembered separately from ours
-- ============================================================================
--
-- Fixes a live-pricing defect. The engine's base for a cell was, in order:
-- the newest reservation's base_rate, else published_price.base_price. And
-- reservations.base_rate is set by the reservations_sync_base_rate trigger to
-- coalesce(base_rate, current_rate) — neither the Cloudbeds nor the Think ETL
-- supplies base_rate, so it is whatever the guest actually paid.
--
-- So once MAYA pushed an adjusted rate and a guest booked at it, that booking
-- came back through the sync and BECAME the cell's base. The rule had not
-- re-fired (ladder rules are transition-based and correctly stay quiet while
-- their condition holds) but the number underneath it had moved, and it only
-- ever moved up. Measured on the sandbox: $200 base, +15% occupancy rule ->
-- $230 published -> guest books at $230 -> next run priced the same single
-- +15% off $230 -> $264.50. Worse, when occupancy fell back and the rule
-- deactivated, that cell reverted to $230, not $200 — the hotel's own rate for
-- the night was gone for good, while cells that never sold reverted correctly.
--
-- This table holds the rate the PROPERTY set, read from the PMS, and the
-- engine prefers it over anything derived from a booking. Nothing MAYA
-- computes is ever written here: it is an input, and the moment our own output
-- can flow back into it we have rebuilt the compounding bug that
-- published_price.base_price exists to prevent.
--
-- Refresh rule (enforced by the writer, not by the schema): a cell may be
-- re-read from the PMS only while MAYA has never pushed a rate to it. After we
-- push, the PMS number contains our adjustment and is no longer the hotel's
-- own rate. rate_updates is the record of what we have pushed.

create table if not exists base_rate_calendar (
  hotel_id     uuid not null references hotels(id) on delete cascade,
  stay_date    date not null,
  room_type_id uuid not null references room_types(id) on delete cascade,
  -- The property's rate for this room-night, exactly as the PMS reports it.
  price        numeric(10,2) not null check (price >= 0),
  -- Where it came from: 'pms' today; leaves room for an imported rate sheet.
  source       text not null default 'pms',
  captured_at  timestamptz not null default now(),
  primary key (hotel_id, stay_date, room_type_id)
);

-- The engine reads a whole horizon at once, hotel + date range.
create index if not exists idx_base_rate_calendar_hotel_stay
  on base_rate_calendar (hotel_id, stay_date);

alter table base_rate_calendar enable row level security;

drop policy if exists base_rate_calendar_access on base_rate_calendar;
create policy base_rate_calendar_access
  on base_rate_calendar for all
  using (is_hotel_accessible(hotel_id))
  with check (can_manage_hotel(hotel_id));
