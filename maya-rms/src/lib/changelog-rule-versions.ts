/**
 * The rule version each fire on the change log's rows was made by, for rows
 * written before the audit kept it (active_pickup_effects[].rule_version and
 * rule_snapshots, since 2026-10-01). With it an old entry still tells a
 * rule's marks while the rule is on that version, and only what the run saw
 * once it has been edited (changelog-route-helpers.ts, ruleAsDecided).
 * Kept out of the route file so the route exports nothing but its handler.
 */

import { ruleSnapshotsOf } from "@/lib/changelog-route-helpers";
import type { EvaluationAuditDetails } from "@/types/domain";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Event ids per read: well inside a request line. */
const CHUNK = 200;

/** The fires on these rows whose version the row itself doesn't give. */
export function firesWithoutVersion(rows: { details?: unknown }[]): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    const details = (row.details ?? null) as Partial<EvaluationAuditDetails> | null;
    const snapshots = ruleSnapshotsOf(details?.rule_snapshots);
    for (const e of details?.active_pickup_effects ?? []) {
      if (!e || typeof e.event_id !== "string") continue;
      if (typeof e.rule_version === "number" || snapshots?.[e.rule_id]) continue;
      ids.add(e.event_id);
    }
  }
  return [...ids];
}

/**
 * pickup_event.rule_version by event id, for the fires firesWithoutVersion
 * names. A failed read is logged and leaves the rest out: those entries then
 * tell only what their run saw, never a mark that may have changed.
 */
export async function pickupVersionsFor(
  supabase: SupabaseClient,
  hotelId: string,
  rows: { details?: unknown }[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ids = firesWithoutVersion(rows);
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await supabase
      .from("pickup_event")
      .select("id, rule_version")
      .eq("hotel_id", hotelId)
      .in("id", ids.slice(i, i + CHUNK));
    if (error) {
      console.error(
        JSON.stringify({ fn: "api/changelog", step: "pickup_versions", hotelId, error: String(error.message).slice(0, 300) }),
      );
      return out;
    }
    for (const r of (data ?? []) as { id: unknown; rule_version: unknown }[]) {
      if (r.rule_version != null && Number.isFinite(Number(r.rule_version))) out.set(String(r.id), Number(r.rule_version));
    }
  }
  return out;
}
