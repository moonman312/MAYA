/**
 * Thin re-export so the Next app and tests share the canonical implementation
 * in supabase/functions/_shared/pms/. Mirrors src/lib/pms/rate-limit.ts.
 */
export {
  dropUnchangedReservationRows,
  reservationRowFingerprint,
  stableStringify,
  type ReservationWriteRow,
} from "../../../supabase/functions/_shared/pms/row-diff";
