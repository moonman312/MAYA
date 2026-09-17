/**
 * How often each rule has fired, for the rules list's "most fired" sort.
 */
import { isMissingFunctionError } from "@/lib/engine/snapshots";
import type { SupabaseClient } from "@supabase/supabase-js";

let loggedFireCountsMissing = false;

/**
 * Fires per rule id. Counting in Postgres: the row-per-fire read stopped at
 * PostgREST's 1,000 rows, so a busy hotel's counts were quietly short and the
 * "most fired" sort was wrong. Before the migration, each rule is counted
 * with two exact head counts instead.
 */
export async function ruleFireCounts(supabase: SupabaseClient, hotelId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const { data, error } = await supabase.rpc("rule_fire_counts", { p_hotel_id: hotelId });
  if (!error) {
    for (const row of (data ?? []) as { rule_id: unknown; fires: unknown }[]) {
      counts[String(row.rule_id)] = Number(row.fires);
    }
    return counts;
  }
  if (!isMissingFunctionError(error)) return counts;
  if (!loggedFireCountsMissing) {
    loggedFireCountsMissing = true;
    console.error(
      JSON.stringify({
        fn: "rule-fire-counts",
        schema: "pre-migration",
        message: "rule_fire_counts does not exist yet; counting per rule. Run 99_supabase_migration_large_property_scale_v1.sql.",
        migration: "99_supabase_migration_large_property_scale_v1.sql",
      }),
    );
  }
  const { data: rules } = await supabase.from("pricing_rules").select("id").eq("hotel_id", hotelId);
  for (const rule of rules ?? []) {
    const id = String(rule.id);
    const [{ count: ladder }, { count: pickup }] = await Promise.all([
      supabase
        .from("ladder_transition_event")
        .select("id", { count: "exact", head: true })
        .eq("hotel_id", hotelId)
        .eq("rule_id", id)
        .eq("transition", "activate"),
      supabase
        .from("pickup_event")
        .select("id", { count: "exact", head: true })
        .eq("hotel_id", hotelId)
        .eq("rule_id", id),
    ]);
    const fires = (ladder ?? 0) + (pickup ?? 0);
    if (fires > 0) counts[id] = fires;
  }
  return counts;
}
