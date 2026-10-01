/**
 * A room type the owner ticks as a room while the property is in simulation
 * joins the starter rules (Jake, 2026-09-30, audit A22). They were built to
 * measure and change every room type that counted as a room at the time, so a
 * type the import had wrongly taken for a parking bay or a meeting room, and
 * the owner then ticked, was left out of both. Now it is added to both sets,
 * as if it had counted when the rules were built.
 *
 * Only the starter rules still as the import built them are touched: the
 * names the import (or the swap the last onboarding question made) put on
 * the property, still at version 1. A rule the owner edited has the room
 * types they chose. Nothing changes on a live property: adding a room type to
 * a rule there moves live prices, and that is the owner's own edit to make.
 *
 * Never throws. The tick is already saved by the time this runs, and failing
 * the answer over its rules would only leave the owner unsure whether it
 * counted; a failure is logged loudly instead.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { starterStatsForStatus } from "@/lib/onboarding/starter-swap";

/** The names of the starter rules an import put on the property, after any swap. */
async function starterRuleNames(admin: SupabaseClient, hotelId: string): Promise<string[]> {
  const [{ data: state }, { data: built, error }] = await Promise.all([
    admin.from("onboarding_states").select("questions").eq("hotel_id", hotelId).maybeSingle(),
    // The newest import that built them: a later "Get suggestions from my
    // data" read builds none (as the status route reads it).
    admin
      .from("import_jobs")
      .select("stats")
      .eq("hotel_id", hotelId)
      .not("stats->starterRules", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (error) throw new Error(`starter rules read failed: ${error.message}`);
  const stats = starterStatsForStatus(
    (built as { stats?: Record<string, unknown> } | null)?.stats ?? null,
    (state as { questions?: unknown } | null)?.questions,
  );
  const rules = Array.isArray(stats?.starterRules) ? (stats.starterRules as Array<{ name?: unknown }>) : [];
  return rules.map((r) => String(r?.name ?? "")).filter((n) => n.length > 0);
}

/**
 * Add `roomTypeId` to what the property's untouched starter rules measure and
 * change, while it is in simulation. Resolves to how many rules it was added
 * to (0 when it is live, there are none, or something failed).
 */
export async function addToStarterRules(
  admin: SupabaseClient,
  hotelId: string,
  roomTypeId: string,
): Promise<number> {
  try {
    const { data: settings, error: settingsErr } = await admin
      .from("hotel_settings")
      .select("simulation_mode")
      .eq("hotel_id", hotelId)
      .maybeSingle();
    if (settingsErr) throw new Error(`simulation mode read failed: ${settingsErr.message}`);
    if ((settings as { simulation_mode?: unknown } | null)?.simulation_mode === false) return 0;

    const names = await starterRuleNames(admin, hotelId);
    if (names.length === 0) return 0;
    const { data: rules, error: rulesErr } = await admin
      .from("pricing_rules")
      .select("id, name, version")
      .eq("hotel_id", hotelId)
      .in("name", names);
    if (rulesErr) throw new Error(`starter rules read failed: ${rulesErr.message}`);
    const ruleIds = ((rules ?? []) as Array<{ id: unknown; version?: unknown }>)
      .filter((r) => Number(r.version ?? 1) === 1)
      .map((r) => String(r.id));
    if (ruleIds.length === 0) return 0;

    const joins = ruleIds.map((ruleId) => ({ rule_id: ruleId, room_type_id: roomTypeId }));
    for (const table of ["rule_signal_room_type", "rule_affected_room_type"] as const) {
      const { error } = await admin
        .from(table)
        .upsert(joins, { onConflict: "rule_id,room_type_id", ignoreDuplicates: true });
      if (error) throw new Error(`${table} write failed: ${error.message}`);
    }
    return ruleIds.length;
  } catch (e) {
    console.error(
      JSON.stringify({
        fn: "addToStarterRules",
        hotelId,
        roomTypeId,
        error: e instanceof Error ? e.message : String(e),
        message: "The room type was ticked as a room but not added to the starter rules.",
      }),
    );
    return 0;
  }
}
