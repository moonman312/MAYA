/**
 * Thin re-export so the Next app can call the shared Cloudbeds sync pipeline
 * (canonical implementation lives in supabase/functions/_shared/cloudbeds/).
 * Mirrors src/lib/mews/sync-hotel.ts.
 */
export {
  runCloudbedsSyncForHotel,
  decideSyncMode,
  sweepIdCompare,
  type SyncMode,
} from "../../../supabase/functions/_shared/cloudbeds/sync-hotel";
export type {
  CloudbedsSyncFailure,
  CloudbedsSyncOptions,
  CloudbedsSyncSuccess,
} from "../../../supabase/functions/_shared/cloudbeds/sync-hotel";
