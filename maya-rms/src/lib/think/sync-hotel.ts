/**
 * Thin re-export so the Next app can call the shared Think sync pipeline
 * (canonical implementation lives in supabase/functions/_shared/think/).
 * Mirrors src/lib/mews/sync-hotel.ts.
 */
export { runThinkSyncForHotel } from "../../../supabase/functions/_shared/think/sync-hotel";
export type {
  ThinkSyncFailure,
  ThinkSyncOptions,
  ThinkSyncSuccess,
} from "../../../supabase/functions/_shared/think/sync-hotel";
