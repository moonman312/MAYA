-- Incremental Cloudbeds sync.
--
-- The scheduled sync re-fetches every reservation in the check-in window on
-- every tick, one getReservation detail call each. At the 220ms pacer that is
-- ~1,360 calls per 5-minute window, which a 30-room property already exceeds —
-- so above that size the sync never completed and (before the budget landed)
-- wrote nothing at all.
--
-- Cloudbeds' getReservations accepts a `modifiedFrom` filter. This was verified
-- directly against the live API rather than taken from the documentation, which
-- does not mention it: unknown parameters are silently IGNORED and return the
-- full set, so `modifiedSince`, `updatedFrom` and `lastModified` all appear to
-- work and do nothing. `modifiedFrom` is the real one — a future date returns
-- zero rows where the others return everything. It takes `YYYY-MM-DD` or
-- `YYYY-MM-DD HH:MM:SS`; ISO-8601 with T/Z is rejected.
--
-- With a watermark, a steady-state tick pulls the handful of bookings that
-- actually changed instead of the whole book.
--
-- Run any time. Idempotent.

alter table pms_connections
  add column if not exists reservations_modified_through timestamptz,
  add column if not exists last_full_sync_at timestamptz;

comment on column pms_connections.reservations_modified_through is
  'Watermark: reservations modified at or before this have been pulled. Null forces a full window sweep. Fed to Cloudbeds getReservations as modifiedFrom, minus an overlap for clock skew.';
comment on column pms_connections.last_full_sync_at is
  'Last unfiltered sweep of the whole check-in window. Incremental pulls cannot see a booking nobody touched, so a periodic full pass is what repairs anything a missed or mis-clocked delta dropped.';
