-- Booking-window per-night backfill (v1)
--
-- booking_window_days was stamped arrival-relative: every night of a
-- multi-night stay carried days-between(booking_date, check_in), so night k
-- of a stay read k days shorter than its true lead time and pickup windows
-- shifted k days into the past for every night after check-in. The ETLs now
-- stamp days-between(booking_date, stay_date) — each night stands on its
-- own — and this recomputes existing rows the same way. Rows without a
-- booking_date are left alone: there is nothing to recompute from.
-- greatest(0, ...) mirrors the ETL clamp and the table's >= 0 check for
-- feeds where the booking date lands after the stay date.
--
-- Run AFTER 02_supabase_schema.sql. Safe to re-run (only touches rows whose
-- stored value differs from the recomputed one).

update reservations
set booking_window_days = greatest(0, stay_date - booking_date)
where booking_date is not null
  and booking_window_days is distinct from greatest(0, stay_date - booking_date);
