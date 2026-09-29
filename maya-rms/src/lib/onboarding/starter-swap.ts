/**
 * The answer to the last onboarding question often arrives after the import
 * built the starter rules: the import tends to finish before the owner even
 * reaches the questions. The import keeps all three sets on the job
 * (supabase/functions/_shared/onboarding/rate-moves.ts starterRuleSets); this
 * swaps the set on the property for the one the answer calls for, but only
 * while nobody has touched it and the property is still in simulation.
 * Otherwise the answer is kept for "Get suggestions from my data".
 */

import { deleteRule } from "@/lib/rules-store";
import { hasHotelRank } from "@/lib/require-supabase-hotel";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  insertStarterRules,
  loadCountingRoomTypeIds,
  type StarterRuleSpec,
} from "../../../supabase/functions/_shared/onboarding/generate-rules";
import type {
  PricingConfidence,
  StarterRuleSet,
  StarterRuleSetKey,
} from "../../../supabase/functions/_shared/onboarding/rate-moves";

const SET_KEYS: readonly StarterRuleSetKey[] = ["none", "automate_current", "find_upside"];

function isSetKey(value: unknown): value is StarterRuleSetKey {
  return typeof value === "string" && (SET_KEYS as readonly string[]).includes(value);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function setOf(stats: Record<string, unknown>, key: StarterRuleSetKey): StarterRuleSet | null {
  const set = record(record(stats.starterRuleSets)[key]);
  return Array.isArray(set.rules) ? (set as unknown as StarterRuleSet) : null;
}

/**
 * The job stats the onboarding status sends the browser: the rules and note
 * of the starter set actually on the property, and never the other sets.
 */
export function starterStatsForStatus(
  stats: Record<string, unknown> | null | undefined,
  questions: unknown,
): Record<string, unknown> | null {
  if (!stats) return null;
  const rest: Record<string, unknown> = { ...stats };
  delete rest.starterRuleSets;
  const swappedTo = record(questions).starterRulesFor;
  const set = isSetKey(swappedTo) ? setOf(stats, swappedTo) : null;
  if (!set) return rest;
  const out: Record<string, unknown> = {
    ...rest,
    starterRules: set.rules.map((r) => ({ name: r.name, explanation: r.explanation })),
  };
  if (set.note) out.starterRulesNote = set.note;
  else delete out.starterRulesNote;
  return out;
}

export type SwapOutcome =
  | { swapped: true; builtFor: StarterRuleSetKey }
  | { swapped: false; reason: "not_built" | "same" | "live" | "not_allowed" | "changed" | "failed" };

/**
 * Swap the starter rules for the set `answer` calls for, when:
 * - the import on record built them and kept its sets,
 * - the property is still in simulation (live prices never move for this),
 * - the person saving is a Revenue Manager or higher, as for any rule change,
 * - the rules on the property are exactly the set built: same names, all on,
 *   never edited, and nothing added.
 * The new rules are written first and the old ones then go the way Delete
 * does (their simulated changes with them); the next run prices the nights
 * with the new ones. A failure anywhere leaves the old set in place.
 */
export async function swapStarterRulesForAnswer(
  supabase: SupabaseClient,
  hotelId: string,
  answer: PricingConfidence | null,
): Promise<SwapOutcome> {
  const { data: state } = await supabase
    .from("onboarding_states")
    .select("import_job_id, questions")
    .eq("hotel_id", hotelId)
    .maybeSingle();
  if (!state?.import_job_id) return { swapped: false, reason: "not_built" };
  const { data: job } = await supabase
    .from("import_jobs")
    .select("stats")
    .eq("id", state.import_job_id)
    .maybeSingle();
  const stats = record(job?.stats);
  if (typeof stats.starterRulesAt !== "string" || !stats.starterRuleSets) {
    return { swapped: false, reason: "not_built" };
  }

  const swappedTo = record(state.questions).starterRulesFor;
  const current: StarterRuleSetKey = isSetKey(swappedTo)
    ? swappedTo
    : isSetKey(stats.starterRulesFor)
      ? stats.starterRulesFor
      : "none";
  const target: StarterRuleSetKey = answer ?? "none";
  if (current === target) return { swapped: false, reason: "same" };
  const targetSet = setOf(stats, target);
  if (!targetSet || targetSet.rules.length === 0) return { swapped: false, reason: "not_built" };

  const { data: settings } = await supabase
    .from("hotel_settings")
    .select("simulation_mode")
    .eq("hotel_id", hotelId)
    .maybeSingle();
  if (settings?.simulation_mode === false) return { swapped: false, reason: "live" };
  if (!(await hasHotelRank(supabase, hotelId, "revenue_manager"))) {
    return { swapped: false, reason: "not_allowed" };
  }

  // The names on the property: the swapped-in set's, or the list the import
  // wrote (which is what it found, even after a pass that died midway).
  const builtNames = isSetKey(swappedTo)
    ? (setOf(stats, swappedTo)?.rules ?? []).map((r) => r.name)
    : (Array.isArray(stats.starterRules) ? stats.starterRules : []).map((r) => String(record(r).name));
  const { data: rules, error: rulesErr } = await supabase
    .from("pricing_rules")
    .select("id, name, is_active, version, action_value, action_direction, dow_mask")
    .eq("hotel_id", hotelId);
  if (rulesErr || !rules) return { swapped: false, reason: "failed" };
  const sorted = (names: string[]) => [...names].sort().join("\u0000");
  const exactly = (names: string[]) =>
    names.length > 0 &&
    rules.length === names.length &&
    sorted(rules.map((r) => String(r.name))) === sorted(names) &&
    rules.every((r) => r.is_active === true && Number(r.version ?? 1) === 1);
  // Already swapped, and only the note of it was lost: say so, and the
  // answer route records it. Sizes and days count as well as names, since
  // the ladder's names come in two sizes.
  const isTargetSet =
    exactly(targetSet.rules.map((r) => r.name)) &&
    rules.every((r) => {
      const spec = targetSet.rules.find((t) => t.name === String(r.name));
      return (
        spec != null &&
        Number(r.action_value) === spec.action.action_value &&
        String(r.action_direction) === spec.action.action_direction &&
        Number(r.dow_mask ?? 127) === (spec.dow_mask ?? 127)
      );
    });
  if (isTargetSet) return { swapped: true, builtFor: target };
  if (!exactly(builtNames)) return { swapped: false, reason: "changed" };

  const failed = (step: string, e: unknown): SwapOutcome => {
    console.error(
      JSON.stringify({
        fn: "swapStarterRulesForAnswer",
        hotelId,
        from: current,
        to: target,
        step,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
    return { swapped: false, reason: "failed" };
  };

  // Everything the new set needs is read before anything changes.
  let roomTypeIds: string[];
  try {
    roomTypeIds = await loadCountingRoomTypeIds(supabase, hotelId);
  } catch (e) {
    return failed("room_types", e);
  }
  if (roomTypeIds.length === 0) return failed("room_types", "no room type counts as a room");

  // The new set goes in first and the old one comes out after, so a failure
  // at any point leaves the property with the set it had, the review still
  // lists what is there, and saving the answer again tries once more.
  let added: string[];
  try {
    added = await insertStarterRules(supabase, hotelId, targetSet.rules, roomTypeIds);
  } catch (e) {
    // insertStarterRules has already taken back what it wrote.
    return failed("insert", e);
  }

  const removed: string[] = [];
  for (const r of rules) {
    if (await deleteRule(String(r.id), supabase)) {
      removed.push(String(r.name));
      continue;
    }
    await putBack(supabase, hotelId, added, setOf(stats, current)?.rules ?? [], removed, roomTypeIds);
    return failed("delete", `could not delete rule ${String(r.id)}`);
  }
  return { swapped: true, builtFor: target };
}

/**
 * Undo a swap that failed halfway through taking the old set out: the new
 * rules go, and the old ones already deleted are written again from the set
 * they were built from (same names, all on, version 1), so the property
 * reads as untouched and the swap can be tried again.
 */
async function putBack(
  supabase: SupabaseClient,
  hotelId: string,
  added: string[],
  oldSet: StarterRuleSpec[],
  removedNames: string[],
  roomTypeIds: string[],
): Promise<void> {
  const problems: string[] = [];
  for (const id of added) {
    if (!(await deleteRule(id, supabase))) problems.push(`could not delete new rule ${id}`);
  }
  const specs = oldSet.filter((spec) => removedNames.includes(spec.name));
  if (specs.length !== removedNames.length) problems.push("old set not on the job");
  try {
    if (specs.length > 0) await insertStarterRules(supabase, hotelId, specs, roomTypeIds);
  } catch (e) {
    problems.push(e instanceof Error ? e.message : String(e));
  }
  if (problems.length > 0) {
    console.error(JSON.stringify({ fn: "swapStarterRulesForAnswer", hotelId, step: "put_back", problems }));
  }
}
