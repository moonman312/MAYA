/**
 * Thin re-export of room-count measurement (canonical implementation lives in
 * supabase/functions/_shared/billing/room-count.ts, because the scheduled sync
 * measures under Deno). Mirrors src/lib/billing/entitlement.ts.
 */

export * from "../../../supabase/functions/_shared/billing/room-count";
