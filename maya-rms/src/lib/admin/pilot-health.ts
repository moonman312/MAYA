import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PilotHealthRow } from "./pilot-health-assess";
import { isMissingFunction } from "./product-analytics";

/**
 * The Pilot health page's rows: platform_pilot_health() in
 * 99_supabase_migration_pilot_health_v1.sql (and _v2), read under the caller's own
 * session so the function's platform-admin check is the gate. What each row
 * means, and what looks wrong in it, is worked out in pilot-health-assess.ts.
 *
 * One read serves both views: every property comes back and the test ones
 * are held back here, so the page can say how many it is not showing. A
 * deployment can run ahead of its migration; then the function is missing,
 * and the page says so in one line rather than failing.
 */

export type PilotHealth =
  | { available: false; reason: string }
  | {
      available: true;
      rows: PilotHealthRow[];
      hiddenTest: number;
      /**
       * Set when the function is the one from before
       * 99_supabase_migration_pilot_health_v2.sql (its rows cannot say
       * whether published prices are waiting to be sent) or before
       * 99_supabase_migration_no_rate_on_record_v1.sql (nor which nights
       * have no rate on record), so "Looks fine" does not cover that, and
       * the page says which file to run.
       */
      missing?: string;
    };

export async function loadPilotHealth(ssr: SupabaseClient, opts: { includeTest: boolean }): Promise<PilotHealth> {
  const { data, error } = await ssr.rpc("platform_pilot_health", { p_include_test: true });
  if (error) {
    if (isMissingFunction(error)) {
      return { available: false, reason: "Run 99_supabase_migration_pilot_health_v1.sql to see this." };
    }
    throw new Error(`platform_pilot_health: ${error.message}`);
  }
  const all = (data ?? []) as PilotHealthRow[];
  const rows = opts.includeTest ? all : all.filter((r) => !r.is_test);
  const beforeV2 = all.some((r) => r.unsent_count === undefined);
  const beforeV4 = all.some((r) => r.no_rate_count === undefined);
  return {
    available: true,
    rows,
    hiddenTest: all.length - rows.length,
    ...(beforeV2
      ? { missing: "Run 99_supabase_migration_pilot_health_v2.sql to see prices that were published and not sent." }
      : beforeV4
        ? { missing: "Run 99_supabase_migration_no_rate_on_record_v1.sql to see the nights the property system has no rate for." }
        : {}),
  };
}
