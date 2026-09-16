/**
 * Ladder rule evaluation — Implementation Guide §7.2, §11 step 6.
 * Deno-portable copy of src/lib/engine/ladder.ts (import paths only differ).
 *
 * Stateful, transition-based evaluation. For each (ladder rule, stay_date,
 * affected_room_type), persists is_active state and emits transition events.
 */

import type { EngineRule } from "./domain.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ruleConditionsMatch } from "./conditions.ts";
import { MIGRATIONS, isMissingColumnError } from "./snapshots.ts";
import type { LadderTransitionAction, RuleMetrics } from "./types.ts";

export type LadderPassResult = {
  rule_id: string;
  rule_version: number;
  stay_date: string;
  room_type_id: string;
  transition: LadderTransitionAction;
  metrics: RuleMetrics;
  action_kind: string;
  action_direction: string;
  action_value: number;
};

/**
 * How a cell's open manual price bears on a FIRST activation. The API route
 * stamps suppressed_at on the rows that exist when the price is typed, but a
 * cell that has never been evaluated (past the scheduled tick's horizon) has
 * no row to stamp. Its first activation asks whether the condition already
 * held when the price was typed; if so the effect was part of what the typed
 * number reset, and the row is born suppressed. A condition that only starts
 * holding later is a fresh trigger and applies on top.
 */
export type OverrideProbe = {
  set_at: string;
  heldAtOverride: () => Promise<boolean>;
};

/**
 * Does ladder_rule_state have the suppressed_at column yet? One cheap read
 * per evaluateHotel run. Before 99_supabase_migration_manual_price_v1.sql
 * the column is missing, and every read or write that names it fails with
 * 42703 — which, left alone, either throws the run away (the effects read)
 * or silently drops every activation (the upsert). Deploy order is not
 * ours to control, so the run notices, logs one line naming the migration,
 * and prices the way it did before manual overrides existed: every active
 * effect applies.
 *
 * Any other failure is reported as supported. The real reads then throw on
 * their own, which is the right outcome for an outage — see
 * loadActiveLadderEffects.
 */
export async function probeSuppressionSupport(
  supabase: SupabaseClient,
  hotelId: string,
): Promise<boolean> {
  const { error } = await supabase.from("ladder_rule_state").select("suppressed_at").limit(1);
  if (!error) return true;
  if (isMissingColumnError(error)) {
    console.error(
      JSON.stringify({
        fn: "evaluateHotel",
        step: "probe_suppressed_at",
        hotelId,
        schema: "pre-migration",
        message: `ladder_rule_state.suppressed_at does not exist yet; manual price overrides cannot suppress rule effects this run and every active ladder effect applies. Run ${MIGRATIONS.manualPrice}.`,
        migration: MIGRATIONS.manualPrice,
        error: error.message,
      }),
    );
    return false;
  }
  console.error(
    JSON.stringify({
      fn: "evaluateHotel",
      step: "probe_suppressed_at",
      hotelId,
      error: error.message,
      assumedSupported: true,
    }),
  );
  return true;
}

/**
 * Run the ladder pass for a single (rule, stay_date, affected_room_type).
 *
 * Returns the transition action taken.
 *
 * `supportsSuppression` is the answer from probeSuppressionSupport; false
 * keeps suppressed_at out of every write so a pre-migration database
 * accepts them.
 */
export async function evaluateLadderTriple(
  supabase: SupabaseClient,
  rule: EngineRule,
  hotelId: string,
  stayDate: string,
  affectedRoomTypeId: string,
  metrics: RuleMetrics,
  evalTs: string,
  override?: OverrideProbe,
  supportsSuppression: boolean = true,
): Promise<LadderPassResult> {
  const matches = ruleConditionsMatch(rule, metrics);

  const { data: priorRow } = await supabase
    .from("ladder_rule_state")
    .select("is_active")
    .eq("rule_id", rule.id)
    .eq("stay_date", stayDate)
    .eq("room_type_id", affectedRoomTypeId)
    .maybeSingle();

  const wasActive = priorRow?.is_active ?? false;
  const rowExists = priorRow != null;
  let transition: LadderTransitionAction = "noop";

  if (matches && !wasActive) {
    transition = "activate";
    // Only a row that never existed can have missed the route's stamp. An
    // existing inactive row has a history: whatever held at the override was
    // already handled, so its re-activation is a fresh trigger.
    const suppressedAt =
      supportsSuppression && !rowExists && override && (await override.heldAtOverride())
        ? override.set_at
        : null;
    await activateLadder(
      supabase,
      rule,
      hotelId,
      stayDate,
      affectedRoomTypeId,
      metrics,
      evalTs,
      suppressedAt,
      supportsSuppression,
    );
  } else if (matches && wasActive) {
    await touchLadderState(supabase, rule.id, stayDate, affectedRoomTypeId, evalTs);
  } else if (!matches && wasActive) {
    transition = "deactivate";
    await deactivateLadder(
      supabase,
      rule,
      hotelId,
      stayDate,
      affectedRoomTypeId,
      metrics,
      evalTs,
      supportsSuppression,
    );
  } else if (!matches && !wasActive && rowExists) {
    await touchLadderState(supabase, rule.id, stayDate, affectedRoomTypeId, evalTs);
  }

  return {
    rule_id: rule.id,
    rule_version: rule.version,
    stay_date: stayDate,
    room_type_id: affectedRoomTypeId,
    transition,
    metrics,
    action_kind: rule.action_type,
    action_direction: rule.action_direction,
    action_value: rule.action_value,
  };
}

async function activateLadder(
  supabase: SupabaseClient,
  rule: EngineRule,
  hotelId: string,
  stayDate: string,
  roomTypeId: string,
  metrics: RuleMetrics,
  evalTs: string,
  suppressedAt: string | null,
  supportsSuppression: boolean,
): Promise<void> {
  await supabase.from("ladder_transition_event").insert({
    hotel_id: hotelId,
    rule_id: rule.id,
    rule_version: rule.version,
    stay_date: stayDate,
    room_type_id: roomTypeId,
    transition: "activate",
    transitioned_at: evalTs,
    metrics_snapshot: metrics,
    action_kind: rule.action_type,
    action_direction: rule.action_direction,
    action_value: rule.action_value,
  });

  await supabase.from("ladder_rule_state").upsert(
    {
      rule_id: rule.id,
      rule_version: rule.version,
      stay_date: stayDate,
      room_type_id: roomTypeId,
      is_active: true,
      activated_at: evalTs,
      deactivated_at: null,
      // A fresh activation is a fresh trigger: if a manual price override
      // had suppressed this row, the rule is now firing on top of the
      // manual base, which is exactly what the override promises. The one
      // exception is a first-ever row whose condition already held when the
      // price was typed (see OverrideProbe).
      ...(supportsSuppression ? { suppressed_at: suppressedAt } : {}),
      last_evaluated_at: evalTs,
      action_kind: rule.action_type,
      action_direction: rule.action_direction,
      action_value: rule.action_value,
    },
    { onConflict: "rule_id,stay_date,room_type_id" },
  );
}

async function deactivateLadder(
  supabase: SupabaseClient,
  rule: EngineRule,
  hotelId: string,
  stayDate: string,
  roomTypeId: string,
  metrics: RuleMetrics,
  evalTs: string,
  supportsSuppression: boolean,
): Promise<void> {
  await supabase.from("ladder_transition_event").insert({
    hotel_id: hotelId,
    rule_id: rule.id,
    rule_version: rule.version,
    stay_date: stayDate,
    room_type_id: roomTypeId,
    transition: "deactivate",
    transitioned_at: evalTs,
    metrics_snapshot: metrics,
    action_kind: rule.action_type,
    action_direction: rule.action_direction,
    action_value: rule.action_value,
  });

  await supabase
    .from("ladder_rule_state")
    .update({
      is_active: false,
      deactivated_at: evalTs,
      // Suppression belongs to the trigger that was already holding when
      // the override landed. Once that trigger ends, the next one is new
      // and applies on top of the manual base.
      ...(supportsSuppression ? { suppressed_at: null } : {}),
      last_evaluated_at: evalTs,
    })
    .eq("rule_id", rule.id)
    .eq("stay_date", stayDate)
    .eq("room_type_id", roomTypeId);
}

/**
 * The condition merely keeps holding. Deliberately does NOT touch
 * suppressed_at: an effect that was already applying when a manual price
 * override landed stays suppressed for as long as that same trigger lasts.
 */
async function touchLadderState(
  supabase: SupabaseClient,
  ruleId: string,
  stayDate: string,
  roomTypeId: string,
  evalTs: string,
): Promise<void> {
  await supabase
    .from("ladder_rule_state")
    .update({ last_evaluated_at: evalTs })
    .eq("rule_id", ruleId)
    .eq("stay_date", stayDate)
    .eq("room_type_id", roomTypeId);
}
