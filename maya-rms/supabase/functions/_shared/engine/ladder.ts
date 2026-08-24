/**
 * Ladder rule evaluation — Implementation Guide §7.2, §11 step 6.
 * Deno-portable copy of src/lib/engine/ladder.ts (import paths only differ).
 */

import type { ActionDirection, ActionKind, EngineRule } from "./domain.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ruleConditionsMatch } from "./conditions.ts";
import { fetchAllRows } from "./snapshots.ts";
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

/** Full ladder_rule_state row — the table has exactly these columns. */
export type LadderStateRow = {
  rule_id: string;
  rule_version: number;
  stay_date: string;
  room_type_id: string;
  is_active: boolean;
  activated_at: string | null;
  deactivated_at: string | null;
  last_evaluated_at: string;
  action_kind: ActionKind;
  action_direction: ActionDirection;
  action_value: number;
};

export const ladderStateKey = (ruleId: string, stayDate: string, roomTypeId: string) =>
  `${ruleId}|${stayDate}|${roomTypeId}`;

export type LadderWriteBuffer = {
  /** Transition events in the order they happened — insert order is preserved. */
  transitions: Record<string, unknown>[];
  /** State rows touched this run; flushed once per key from the map's final state. */
  dirtyKeys: Set<string>;
};

export const newLadderWriteBuffer = (): LadderWriteBuffer => ({
  transitions: [],
  dirtyKeys: new Set(),
});

/**
 * Preload every ladder_rule_state row the run can read or write: all rules'
 * states (disabled rules' frozen states included — pricing applies them) for
 * the horizon's dates and the union of active + affected room types.
 */
export async function loadLadderStates(
  supabase: SupabaseClient,
  firstDate: string,
  lastDate: string,
  roomTypeIds: string[],
): Promise<Map<string, LadderStateRow>> {
  const rows = await fetchAllRows(() =>
    supabase
      .from("ladder_rule_state")
      .select(
        "rule_id, rule_version, stay_date, room_type_id, is_active, activated_at, deactivated_at, last_evaluated_at, action_kind, action_direction, action_value",
      )
      .gte("stay_date", firstDate)
      .lte("stay_date", lastDate)
      .in("room_type_id", roomTypeIds)
      .order("rule_id", { ascending: true })
      .order("stay_date", { ascending: true })
      .order("room_type_id", { ascending: true }),
  );
  const map = new Map<string, LadderStateRow>();
  for (const r of rows) {
    const row: LadderStateRow = {
      rule_id: String(r.rule_id),
      rule_version: Number(r.rule_version),
      stay_date: String(r.stay_date),
      room_type_id: String(r.room_type_id),
      is_active: Boolean(r.is_active),
      activated_at: r.activated_at != null ? String(r.activated_at) : null,
      deactivated_at: r.deactivated_at != null ? String(r.deactivated_at) : null,
      last_evaluated_at: String(r.last_evaluated_at),
      action_kind: String(r.action_kind) as ActionKind,
      action_direction: String(r.action_direction) as ActionDirection,
      action_value: Number(r.action_value),
    };
    map.set(ladderStateKey(row.rule_id, row.stay_date, row.room_type_id), row);
  }
  return map;
}

/**
 * Run the ladder pass for a single (rule, stay_date, affected_room_type)
 * against the in-memory state map, buffering the writes.
 *
 * Returns the transition action taken.
 */
export function evaluateLadderTriple(
  states: Map<string, LadderStateRow>,
  buf: LadderWriteBuffer,
  rule: EngineRule,
  hotelId: string,
  stayDate: string,
  affectedRoomTypeId: string,
  metrics: RuleMetrics,
  evalTs: string,
): LadderPassResult {
  const matches = ruleConditionsMatch(rule, metrics);

  const key = ladderStateKey(rule.id, stayDate, affectedRoomTypeId);
  const prior = states.get(key);
  const wasActive = prior?.is_active ?? false;
  const rowExists = prior != null;
  let transition: LadderTransitionAction = "noop";

  if (matches && !wasActive) {
    transition = "activate";
    buf.transitions.push({
      hotel_id: hotelId,
      rule_id: rule.id,
      rule_version: rule.version,
      stay_date: stayDate,
      room_type_id: affectedRoomTypeId,
      transition: "activate",
      transitioned_at: evalTs,
      metrics_snapshot: metrics,
      action_kind: rule.action_type,
      action_direction: rule.action_direction,
      action_value: rule.action_value,
    });
    states.set(key, {
      rule_id: rule.id,
      rule_version: rule.version,
      stay_date: stayDate,
      room_type_id: affectedRoomTypeId,
      is_active: true,
      activated_at: evalTs,
      deactivated_at: null,
      last_evaluated_at: evalTs,
      action_kind: rule.action_type,
      action_direction: rule.action_direction,
      action_value: rule.action_value,
    });
    buf.dirtyKeys.add(key);
  } else if (matches && wasActive) {
    prior!.last_evaluated_at = evalTs;
    buf.dirtyKeys.add(key);
  } else if (!matches && wasActive) {
    transition = "deactivate";
    buf.transitions.push({
      hotel_id: hotelId,
      rule_id: rule.id,
      rule_version: rule.version,
      stay_date: stayDate,
      room_type_id: affectedRoomTypeId,
      transition: "deactivate",
      transitioned_at: evalTs,
      metrics_snapshot: metrics,
      action_kind: rule.action_type,
      action_direction: rule.action_direction,
      action_value: rule.action_value,
    });
    prior!.is_active = false;
    prior!.deactivated_at = evalTs;
    prior!.last_evaluated_at = evalTs;
    buf.dirtyKeys.add(key);
  } else if (!matches && !wasActive && rowExists) {
    prior!.last_evaluated_at = evalTs;
    buf.dirtyKeys.add(key);
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

/**
 * Land the buffered ladder writes: transition events in order, then one
 * upsert per dirty state key carrying the map's FINAL row. One row per key
 * — a key visited twice in one run (duplicate-affected) must not appear
 * twice in a single upsert statement, and the final in-memory row is by
 * construction what the old sequential writes left behind.
 *
 * Write failures are logged, never thrown — the same posture the old
 * per-triple writes had (their errors went unchecked). The next run reloads
 * from the DB and re-derives any transition that failed to land.
 */
export async function flushLadderWrites(
  supabase: SupabaseClient,
  states: Map<string, LadderStateRow>,
  buf: LadderWriteBuffer,
): Promise<void> {
  const CHUNK = 500;

  for (let i = 0; i < buf.transitions.length; i += CHUNK) {
    const { error } = await supabase
      .from("ladder_transition_event")
      .insert(buf.transitions.slice(i, i + CHUNK));
    if (error) {
      console.error(
        JSON.stringify({ fn: "flushLadderWrites", table: "ladder_transition_event", error: error.message }),
      );
    }
  }

  const stateRows: LadderStateRow[] = [];
  for (const key of buf.dirtyKeys) {
    const row = states.get(key);
    if (row) stateRows.push(row);
  }
  for (let i = 0; i < stateRows.length; i += CHUNK) {
    const { error } = await supabase
      .from("ladder_rule_state")
      .upsert(stateRows.slice(i, i + CHUNK), { onConflict: "rule_id,stay_date,room_type_id" });
    if (error) {
      console.error(
        JSON.stringify({ fn: "flushLadderWrites", table: "ladder_rule_state", error: error.message }),
      );
    }
  }
}
