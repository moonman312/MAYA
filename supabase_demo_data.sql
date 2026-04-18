-- Populate synthetic reservation + metrics data for MAYA testing.
-- Safe to rerun (uses deterministic IDs + upserts).
--
-- Prereqs:
-- 1) Run supabase_base_schema.sql
-- 2) Run supabase_schema.sql
-- 3) Run supabase_seed.sql (creates hotels, memberships, room types)

-- ----------------------------------------------------------------------------
-- Synthetic reservations
-- ----------------------------------------------------------------------------

with base as (
  select
    h.id as hotel_id,
    rt.total_rooms as inventory_per_type,
    rt.id as room_type_id,
    rt.name as room_type_name,
    case
      when lower(rt.name) like '%suite%' then 395::numeric
      when lower(rt.name) like '%deluxe%' then 245::numeric
      else 175::numeric
    end as base_rate
  from hotels h
  join room_types rt on rt.hotel_id = h.id
  where h.is_active = true
    and rt.is_active = true
),
dates as (
  select generate_series(current_date - 30, current_date + 120, interval '1 day')::date as stay_date
),
targets as (
  select
    b.hotel_id,
    b.room_type_id,
    b.room_type_name,
    b.base_rate,
    b.inventory_per_type,
    d.stay_date,
    -- deterministic occupancy target between ~25% and ~90%
    greatest(
      1,
      least(
        b.inventory_per_type,
        floor(
          b.inventory_per_type *
          (
            0.25 +
            (
              abs(
                (('x' || substr(md5(b.hotel_id::text || b.room_type_id::text || d.stay_date::text), 1, 8))::bit(32)::int)
              ) % 65
            ) / 100.0
          )
        )::int
      )
    ) as booked_count
  from base b
  cross join dates d
),
expanded as (
  select
    t.hotel_id,
    t.room_type_id,
    t.room_type_name,
    t.base_rate,
    t.stay_date,
    gs as seq,
    format(
      'demo-%s-%s-%s-%s',
      t.hotel_id::text,
      t.room_type_id::text,
      to_char(t.stay_date, 'YYYYMMDD'),
      lpad(gs::text, 3, '0')
    ) as external_reservation_id
  from targets t
  join lateral generate_series(1, t.booked_count) gs on true
),
rows_to_insert as (
  select
    gen_random_uuid() as id,
    e.hotel_id,
    e.external_reservation_id,
    e.room_type_id,
    e.stay_date,
    (e.stay_date - ((e.seq % 60) + 1))::date as booking_date,
    ((e.seq % 60) + 1)::int as booking_window_days,
    round(
      (
        e.base_rate
        * (
          0.9
          + (
            abs(
              (('x' || substr(md5(e.external_reservation_id), 1, 8))::bit(32)::int)
            ) % 41
          ) / 100.0
        )
      )::numeric,
      2
    ) as current_rate
  from expanded e
)
insert into reservations (
  id,
  hotel_id,
  external_reservation_id,
  room_type_id,
  stay_date,
  booking_date,
  booking_window_days,
  current_rate,
  raw_payload,
  created_at,
  updated_at
)
select
  r.id,
  r.hotel_id,
  r.external_reservation_id,
  r.room_type_id,
  r.stay_date,
  r.booking_date,
  r.booking_window_days,
  r.current_rate,
  jsonb_build_object('source', 'synthetic_seed'),
  now(),
  now()
from rows_to_insert r
on conflict (hotel_id, external_reservation_id, stay_date)
do update set
  room_type_id = excluded.room_type_id,
  booking_date = excluded.booking_date,
  booking_window_days = excluded.booking_window_days,
  current_rate = excluded.current_rate,
  updated_at = now();

-- ----------------------------------------------------------------------------
-- Occupancy metrics derived from reservations
-- ----------------------------------------------------------------------------

with agg as (
  select
    r.hotel_id,
    r.room_type_id,
    r.stay_date,
    count(*)::int as occupancy
  from reservations r
  where r.room_type_id is not null
  group by r.hotel_id, r.room_type_id, r.stay_date
),
with_prev as (
  select
    a.hotel_id,
    a.room_type_id,
    a.stay_date,
    a.occupancy,
    lag(a.occupancy) over (
      partition by a.hotel_id, a.room_type_id
      order by a.stay_date
    ) as prev_occupancy
  from agg a
)
insert into occupancy_metrics (
  id,
  hotel_id,
  room_type_id,
  stay_date,
  occupancy,
  pickup_rate,
  updated_at
)
select
  gen_random_uuid(),
  wp.hotel_id,
  wp.room_type_id,
  wp.stay_date,
  wp.occupancy,
  greatest(wp.occupancy - coalesce(wp.prev_occupancy, 0), 0)::int as pickup_rate,
  now()
from with_prev wp
on conflict (hotel_id, room_type_id, stay_date)
do update set
  occupancy = excluded.occupancy,
  pickup_rate = excluded.pickup_rate,
  updated_at = now();

-- ----------------------------------------------------------------------------
-- Quick sanity output
-- ----------------------------------------------------------------------------

select
  h.name as hotel_name,
  count(*)::int as reservation_rows
from reservations r
join hotels h on h.id = r.hotel_id
group by h.name
order by h.name;
