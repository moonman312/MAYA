-- Remember the base price, so the engine stops reading its own output back
-- in as input.
--
-- The bug: when a stay date has no reservation carrying a base_rate — the
-- last booking cancelled, or its rate is 0 — the engine fell back to reading
-- published_price as the base. But published_price holds the FINAL price,
-- after every ladder and pickup effect and after clamping. Applying those
-- same still-active effects to it again compounds them, once per run, every
-- five minutes:
--
--   $200 with an active -15% pickup event and no reservations left
--   -> 170 -> 144.50 -> 122.83 -> ... -> the $1.00 floor in about 30 runs,
--   roughly two and a half hours, pushed to the PMS at every step.
--
-- A rule firing repeatedly while a date stays slow is intended behaviour and
-- is governed by cooldowns. This was not that: nothing re-fired, no
-- condition was re-checked, and the trigger was a vanished reservation row
-- rather than anything about demand.
--
-- reservations.base_rate exists precisely to make re-evaluation idempotent
-- (see the reservations_sync_base_rate trigger), but it disappears with the
-- reservation. published_price.base_price is the durable memory of the same
-- number, so a cancellation leaves the price where it was instead of setting
-- it adrift.

alter table published_price
  add column if not exists base_price numeric(10,2);

comment on column published_price.base_price is
  'The clean pre-adjustment price this row was computed from. The engine reads '
  'THIS as its base when no reservation carries a base_rate — never price, '
  'which already contains the rules'' effects.';

-- Backfill from the audit trail, which has recorded the clean base all along.
-- Without this, existing rows have no remembered base and the affected cells
-- simply stop being repriced until a booking re-establishes one — safe, but
-- needlessly frozen when the answer is already on disk.
update published_price pp
   set base_price = latest.base_price
  from (
    select distinct on (hotel_id, stay_date, room_type_id)
           hotel_id, stay_date, room_type_id, base_price
      from evaluation_audit
     where base_price is not null
     order by hotel_id, stay_date, room_type_id, evaluated_at desc
  ) as latest
 where pp.hotel_id = latest.hotel_id
   and pp.stay_date = latest.stay_date
   and pp.room_type_id = latest.room_type_id
   and pp.base_price is null;
