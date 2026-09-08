-- ============================================================================
-- Cloudbeds historical room-night re-key (v1)
--
-- Two import paths wrote the same room-night under two different keys. The
-- onboarding historical pull keyed its rows by the parent reservationID, while
-- the live detail sync keyed them per room. `reservations` is unique on
-- (hotel_id, external_reservation_id, stay_date), so as soon as a refresh
-- import re-walked check-ins the detail sync had already stored, the historical
-- rows inserted a SECOND copy of those room-nights instead of upserting over
-- them, and occupancy history doubled on every affected date. Both paths now
-- key every room in the `<reservationID>-<n>` namespace (cloudbeds/etl.ts
-- cloudbedsRoomRowIds); this repairs the rows already in the table.
--
-- Which rows are the historical ones: the import worker is the only writer that
-- stores raw_payload as null, and the code THAT WROTE THESE ROWS only ever
-- imported check-ins ≥366 days back (its first historical window was
-- [today-730, today-366]) — hence the stay_date bound, set at 300 days so a long
-- stay straddling the edge of that window is still covered. The bound is what
-- keeps a payload nulled for some other reason (the PII backfill's non-object
-- branch, 99_supabase_migration_pii_redaction_v1.sql) out of scope, since
-- re-keying a live detail row would orphan it. NOTE: the worker now anchors its
-- history at the live sync's coverage edge, so rows it writes from here on can
-- have recent stay dates — they are already keyed per room and need no repair,
-- which is why this bound is stated against the old code rather than the
-- current one.
--
-- Ids already ending in -<digits> are left alone: they cannot be told apart from
-- real per-room ids. Two consequences, both by design:
--   • A booking whose id itself ends in -<digits> keeps its duplicate.
--   • Detail rows keyed by a bare physical roomID (an account whose
--     subReservationID was not parent-prefixed, so the old detail path fell back
--     to roomID) are invisible here. The new keying no longer writes them, so
--     they linger as phantom booked nights. Nothing can identify them from the
--     row alone — the parent id was never stored. If a property's history shows
--     inflated occupancy after this runs, the fix is to delete that hotel's
--     Cloudbeds reservations and re-import, not a blind predicate.
--
-- base_rate is deliberately left as-is. reservations_sync_base_rate pins it to
-- the first rate seen and no UPDATE can clear it, so these rows keep the
-- whole-booking rate they were imported with. They are all past stay dates and
-- the engine only reads base_rate for dates it is pricing, so nothing prices
-- off them; a property that wants the rates themselves rebuilt has to re-run
-- the import after deleting its historical rows.
--
-- Data only — nothing to fold into 02_supabase_schema.sql.
-- Run AFTER 02_supabase_schema.sql. Safe to re-run: a second pass finds no
-- parent-keyed historical rows left. Statement 1 removes exactly the rows whose
-- per-room sibling already occupies the key statement 2 renames into, so
-- statement 2 cannot violate the unique key.
-- ============================================================================

-- 1. Drop the duplicates. A parent-keyed row whose booking already has per-room
--    rows for that night is the extra copy.
delete from reservations r
where r.raw_payload is null
  and r.stay_date < current_date - 300
  and r.external_reservation_id !~ '-[0-9]+$'
  and exists (
    select 1
    from pms_connections c
    where c.hotel_id = r.hotel_id
      and c.pms_type = 'cloudbeds'
  )
  and exists (
    select 1
    from reservations d
    where d.hotel_id = r.hotel_id
      and d.stay_date = r.stay_date
      and d.external_reservation_id ~ '-[0-9]+$'
      and starts_with(d.external_reservation_id, r.external_reservation_id || '-')
  );

-- 2. Move what survives into the booking's first room slot, so the next import
--    of that booking upserts onto these rows instead of adding a copy.
update reservations r
set external_reservation_id = r.external_reservation_id || '-1',
    updated_at = now()
where r.raw_payload is null
  and r.stay_date < current_date - 300
  and r.external_reservation_id !~ '-[0-9]+$'
  and exists (
    select 1
    from pms_connections c
    where c.hotel_id = r.hotel_id
      and c.pms_type = 'cloudbeds'
  );

-- Verification (run manually):
--   select count(*) from reservations r
--   where r.raw_payload is null
--     and r.stay_date < current_date - 300
--     and r.external_reservation_id !~ '-[0-9]+$'
--     and exists (select 1 from pms_connections c
--                 where c.hotel_id = r.hotel_id and c.pms_type = 'cloudbeds');
--   -- must return 0
