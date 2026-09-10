/**
 * Thin re-export of the connection-health helpers (canonical implementation
 * lives in supabase/functions/_shared/pms/connection-health.ts, because the
 * scheduled sync runs under Deno). Mirrors src/lib/billing/entitlement.ts.
 *
 * The webhook receiver needs the same "this grant is gone" write the sync path
 * uses, and there must be exactly one of it: a property that disconnected in
 * Cloudbeds and a property whose token started 401ing are the same condition,
 * and they have to leave the same trail.
 */

export * from "../../../supabase/functions/_shared/pms/connection-health";
