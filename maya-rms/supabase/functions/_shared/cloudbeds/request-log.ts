/**
 * Wires the Cloudbeds client's pluggable request logger to pms_request_log.
 *
 * Inserts are fire-and-forget (void'ed, failures only reach console) so
 * observability can never slow down or break PMS traffic. Installed at the
 * entry of each service-role operation that has a hotel in scope; module-level
 * state is fine because a worker invocation handles a single hotel.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { setCloudbedsRequestLogger } from "./client.ts";

export function installCloudbedsRequestLogging(
  supabase: SupabaseClient,
  hotelId: string,
): void {
  setCloudbedsRequestLogger((entry) => {
    void supabase
      .from("pms_request_log")
      .insert({
        hotel_id: hotelId,
        pms_type: "cloudbeds",
        http_method: entry.method,
        endpoint: entry.endpoint,
        status_code: entry.statusCode,
        ok: entry.ok,
        duration_ms: entry.durationMs,
        message: entry.message ?? null,
      })
      .then(
        ({ error }) => {
          if (error) console.error("pms_request_log insert failed:", error.message);
        },
        (e: unknown) => {
          console.error(
            "pms_request_log insert failed:",
            e instanceof Error ? e.message : String(e),
          );
        },
      );
  });
}
