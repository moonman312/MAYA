/**
 * Thin re-export of the entitlement predicate (canonical implementation lives
 * in supabase/functions/_shared/billing/entitlement.ts, because the scheduled
 * sync runs under Deno). Mirrors src/lib/observations/seasons.ts.
 */

export * from "../../../supabase/functions/_shared/billing/entitlement";
