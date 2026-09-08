/**
 * Thin re-export of the PMS rate limiter (canonical implementation lives in
 * supabase/functions/_shared/pms/rate-limit.ts, because the scheduled syncs that
 * need it run under Deno). Mirrors src/lib/billing/entitlement.ts.
 */

export * from "../../../supabase/functions/_shared/pms/rate-limit";
