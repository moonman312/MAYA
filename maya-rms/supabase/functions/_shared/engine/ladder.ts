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
  /** Keys that ACTIVATED this run — the only rows flushed as full upserts, since activation owns every column. */
  activatedKeys: Set<string>;
  /** Deactivated stay_dates per "rule|room_type" — flushed as scoped UPDATEs of the deactivation columns only. */
  deactivated: Map<string, Set<string>>;
  /** Touched stay_dates per "rule|room_type" — flushed as scoped UPDATEs of last_evaluated_at ONLY. A touch must never be able to write is_active: a concurrent run's just-landed transition would be silently reverted by a stale full-row write. */
  touched: Map<string, Set<string>>;
};

export const newLadderWriteBuffer = (): LadderWriteBuffer => ({
  transitions: [],
  activatedKeys: new Set(),
  deactivated: new Map(),
  touched: new Map(),
});

const addToSetMap = (m: Map<string, Set<string>>, key: string, value: string) => {
  const set = m.get(key) ?? new Set<string>();
  set.add(value);
  m.set(key, set);
};

/**
 * Preload every ladder_rule_state row the run can read or write: ALL of the
 * hotel's rules' states — disabled rules' frozen states included, since
 * pricing applies them — for the horizon's dates and the union of active +
 * affected room types. ruleIds must therefore be the hotel's FULL rule-id
 * list, never just the active ones. It also keys the read to the table's
 * primary index (the PK leads with rule_id); the table has no hotel column,
 * so without it this is a seq scan across every tenant.
 */
export async function loadLadderStates(
  supabase: SupabaseClient,
  ruleIds: string[],
  firstDate: string,
  lastDate: string,
  roomTypeIds: string[],
): Promise<Map<string, LadderStateRow>> {
  if (ruleIds.length === 0) return new Map();
  const rows = await fetchAllRows(() =>
    supabase
      .from("ladder_rule_state")
      .select(
        "rule_id, rule_version, stay_date, room_type_id, is_active, activated_at, deactivated_at, last_evaluated_at, action_kind, action_direction, action_value",
      )
      .in("rule_id", ruleIds)
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
    buf.activatedKeys.add(key);
  } else if (matches && wasActive) {
    prior!.last_evaluated_at = evalTs;
    // A key that activated this run already carries this instant in its
    // upsert row — only pre-existing rows need the touch write.
    if (!buf.activatedKeys.has(key)) {
      addToSetMap(buf.touched, `${rule.id}|${affectedRoomTypeId}`, stayDate);
    }
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
    addToSetMap(buf.deactivated, `${rule.id}|${affectedRoomTypeId}`, stayDate);
  } else if (!matches && !wasActive && rowExists) {
    prior!.last_evaluated_at = evalTs;
    addToSetMap(buf.touched, `${rule.id}|${affectedRoomTypeId}`, stayDate);
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
 * Land the buffered ladder writes, grouped PER RULE so one rule's failure
 * (say, the rule was deleted mid-run — its state upsert hits the FK) can
 * never take other rules' writes down with it; the old per-triple writes
 * had exactly that one-rule blast radius.
 *
 * Per rule, semantics match the old writes column for column: activations
 * upsert full rows (activation owns every column — a key visited twice this
 * run appears once, carrying the map's final state); deactivations UPDATE
 * only the deactivation columns; touches UPDATE only last_evaluated_at.
 * Scoped UPDATEs no-op on concurrently deleted rows and can never flip
 * is_active from a stale preload.
 *
 * State rows land BEFORE the rule's transition events, and the events are
 * skipped when a state write failed: with the state unlanded, the next run
 * re-derives the same transition and inserts its event then — no duplicate
 * ledger rows, no orphaned ones. (The reverse residue — states landed,
 * event insert then fails — loses that ledger entry; without a transaction
 * that leg is unclosable, and it matches the old unchecked-insert posture.)
 * Failures are logged, never thrown.
 */
export async function flushLadderWrites(
  supabase: SupabaseClient,
  states: Map<string, LadderStateRow>,
  buf: LadderWriteBuffer,
): Promise<void> {
  const CHUNK = 500;
  const logError = (table: string, ruleId: string, message: string) =>
    console.error(JSON.stringify({ fn: "flushLadderWrites", table, ruleId, error: message }));

  // Rules in first-appearance order, from every buffer section.
  const ruleIds: string[] = [];
  const seen = new Set<string>();
  const noteRule = (id: string) => {
    if (!seen.has(id)) {
      seen.add(id);
      ruleIds.push(id);
    }
  };
  for (const t of buf.transitions) noteRule(String(t.rule_id));
  for (const key of buf.activatedKeys) noteRule(key.split("|")[0]);
  for (const key of buf.deactivated.keys()) noteRule(key.split("|")[0]);
  for (const key of buf.touched.keys()) noteRule(key.split("|")[0]);

  for (const ruleId of ruleIds) {
    let stateWritesOk = true;

    const activateRows: LadderStateRow[] = [];
    for (const key of buf.activatedKeys) {
      if (key.startsWith(`${ruleId}|`)) {
        const row = states.get(key);
        if (row) activateRows.push(row);
      }
    }
    for (let i = 0; i < activateRows.length; i += CHUNK) {
      const { error } = await supabase
        .from("ladder_rule_state")
        .upsert(activateRows.slice(i, i + CHUNK), { onConflict: "rule_id,stay_date,room_type_id" });
      if (error) {
        stateWritesOk = false;
        logError("ladder_rule_state", ruleId, error.message);
      }
    }

    for (const [groupKey, dates] of buf.deactivated) {
      const [rid, roomTypeId] = groupKey.split("|");
      if (rid !== ruleId) continue;
      const sample = states.get(ladderStateKey(rid, [...dates][0], roomTypeId));
      const { error } = await supabase
        .from("ladder_rule_state")
        .update({
          is_active: false,
          deactivated_at: sample?.deactivated_at ?? null,
          last_evaluated_at: sample?.last_evaluated_at,
        })
        .eq("rule_id", rid)
        .eq("room_type_id", roomTypeId)
        .in("stay_date", [...dates]);
      if (error) {
        stateWritesOk = false;
        logError("ladder_rule_state", ruleId, error.message);
      }
    }

    for (const [groupKey, dates] of buf.touched) {
      const [rid, roomTypeId] = groupKey.split("|");
      if (rid !== ruleId) continue;
      const sample = states.get(ladderStateKey(rid, [...dates][0], roomTypeId));
      const { error } = await supabase
        .from("ladder_rule_state")
        .update({ last_evaluated_at: sample?.last_evaluated_at })
        .eq("rule_id", rid)
        .eq("room_type_id", roomTypeId)
        .in("stay_date", [...dates]);
      if (error) {
        stateWritesOk = false;
        logError("ladder_rule_state", ruleId, error.message);
      }
    }

    const events = buf.transitions.filter((t) => String(t.rule_id) === ruleId);
    if (!stateWritesOk && events.length > 0) {
      logError("ladder_transition_event", ruleId, "skipped: state writes failed; next run re-derives");
      continue;
    }
    for (let i = 0; i < events.length; i += CHUNK) {
      const { error } = await supabase
        .from("ladder_transition_event")
        .insert(events.slice(i, i + CHUNK));
      if (error) logError("ladder_transition_event", ruleId, error.message);
    }
  }
}
