/**
 * Ladder rule evaluation — Implementation Guide §7.2, §11 step 6.
 * Deno-portable copy of src/lib/engine/ladder.ts (import paths only differ).
 */

import type { EngineRule } from "./domain.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ruleConditionsMatch } from "./conditions.ts";
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

/** Run the ladder pass for a single (rule, stay_date, affected_room_type). */
export async function evaluateLadderTriple(
  supabase: SupabaseClient,
  rule: EngineRule,
  hotelId: string,
  stayDate: string,
  affectedRoomTypeId: string,
  metrics: RuleMetrics,
  evalTs: string,
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
    await activateLadder(supabase, rule, hotelId, stayDate, affectedRoomTypeId, metrics, evalTs);
  } else if (matches && wasActive) {
    await touchLadderState(supabase, rule.id, stayDate, affectedRoomTypeId, evalTs);
  } else if (!matches && wasActive) {
    transition = "deactivate";
    await deactivateLadder(supabase, rule, hotelId, stayDate, affectedRoomTypeId, metrics, evalTs);
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
      last_evaluated_at: evalTs,
    })
    .eq("rule_id", rule.id)
    .eq("stay_date", stayDate)
    .eq("room_type_id", roomTypeId);
}

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
