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
import { MIGRATIONS, fetchAllRows, isMissingColumnError } from "./snapshots.ts";
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
  /**
   * The whole pass's prior state and write queue (see LadderPassBatch). When
   * given, nothing is read or written here; the caller flushes once.
   */
  batch?: LadderPassBatch,
): Promise<LadderPassResult> {
  const matches = ruleConditionsMatch(rule, metrics);

  let priorRow: { is_active: boolean } | null;
  if (batch) {
    priorRow = batch.state(rule.id, stayDate, affectedRoomTypeId);
  } else {
    const { data } = await supabase
      .from("ladder_rule_state")
      .select("is_active")
      .eq("rule_id", rule.id)
      .eq("stay_date", stayDate)
      .eq("room_type_id", affectedRoomTypeId)
      .maybeSingle();
    priorRow = data;
  }

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
    if (batch) {
      batch.activate(rule, hotelId, stayDate, affectedRoomTypeId, metrics, evalTs, suppressedAt, supportsSuppression);
    } else await activateLadder(
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
    if (batch) batch.touch(rule.id, stayDate, affectedRoomTypeId, evalTs);
    else await touchLadderState(supabase, rule.id, stayDate, affectedRoomTypeId, evalTs);
  } else if (!matches && wasActive) {
    transition = "deactivate";
    if (batch) {
      batch.deactivate(rule, hotelId, stayDate, affectedRoomTypeId, metrics, evalTs, supportsSuppression);
    } else await deactivateLadder(
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
    if (batch) batch.touch(rule.id, stayDate, affectedRoomTypeId, evalTs);
    else await touchLadderState(supabase, rule.id, stayDate, affectedRoomTypeId, evalTs);
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

/* ── Whole-pass batching ────────────────────────────────────────── */

const WRITE_CHUNK = 500;
const KEY_CHUNK = 200;

function transitionEventRow(
  rule: EngineRule,
  hotelId: string,
  stayDate: string,
  roomTypeId: string,
  transition: "activate" | "deactivate",
  metrics: RuleMetrics,
  evalTs: string,
) {
  return {
    hotel_id: hotelId,
    rule_id: rule.id,
    rule_version: rule.version,
    stay_date: stayDate,
    room_type_id: roomTypeId,
    transition,
    transitioned_at: evalTs,
    metrics_snapshot: metrics,
    action_kind: rule.action_type,
    action_direction: rule.action_direction,
    action_value: rule.action_value,
  };
}

function activationRow(
  rule: EngineRule,
  stayDate: string,
  roomTypeId: string,
  evalTs: string,
  suppressedAt: string | null,
  supportsSuppression: boolean,
) {
  return {
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
  };
}

function deactivationPatch(evalTs: string, supportsSuppression: boolean) {
  return {
    is_active: false,
    deactivated_at: evalTs,
    // Suppression belongs to the trigger that was already holding when
    // the override landed. Once that trigger ends, the next one is new
    // and applies on top of the manual base.
    ...(supportsSuppression ? { suppressed_at: null } : {}),
    last_evaluated_at: evalTs,
  };
}

/**
 * One ladder pass's prior state, read once, and its writes, sent once.
 *
 * The per-triple path made a read and up to two writes for every (rule,
 * stay date, affected room type): tens of thousands of round trips a run on
 * a large property. Here the state for every ladder rule across the horizon
 * is paged in up front, each triple is decided in memory in the same order,
 * and the writes go out in chunks at the end. Nothing reads ladder state or
 * transition events between the pass and the flush, so the result is the
 * same. A chunk that fails is retried row by row, so one bad row costs that
 * row alone, as it did before; write errors stay unreported, as before.
 */
export type LadderPassBatch = {
  state: (ruleId: string, stayDate: string, roomTypeId: string) => { is_active: boolean } | null;
  activate: (
    rule: EngineRule,
    hotelId: string,
    stayDate: string,
    roomTypeId: string,
    metrics: RuleMetrics,
    evalTs: string,
    suppressedAt: string | null,
    supportsSuppression: boolean,
  ) => void;
  deactivate: (
    rule: EngineRule,
    hotelId: string,
    stayDate: string,
    roomTypeId: string,
    metrics: RuleMetrics,
    evalTs: string,
    supportsSuppression: boolean,
  ) => void;
  touch: (ruleId: string, stayDate: string, roomTypeId: string, evalTs: string) => void;
  flush: () => Promise<void>;
};

export async function createLadderPassBatch(
  supabase: SupabaseClient,
  ruleIds: string[],
  firstDate: string,
  lastDate: string,
): Promise<LadderPassBatch> {
  const states = new Map<string, { is_active: boolean }>();
  if (ruleIds.length > 0) {
    for (let i = 0; i < ruleIds.length; i += KEY_CHUNK) {
      const rows = await fetchAllRows(() =>
        supabase
          .from("ladder_rule_state")
          .select("rule_id, stay_date, room_type_id, is_active")
          .in("rule_id", ruleIds.slice(i, i + KEY_CHUNK))
          .gte("stay_date", firstDate)
          .lte("stay_date", lastDate)
          .order("rule_id", { ascending: true })
          .order("stay_date", { ascending: true })
          .order("room_type_id", { ascending: true }),
      );
      for (const r of rows) {
        states.set(`${r.rule_id}|${r.stay_date}|${r.room_type_id}`, { is_active: Boolean(r.is_active) });
      }
    }
  }

  // deno-lint-ignore no-explicit-any
  const events: any[] = [];
  // deno-lint-ignore no-explicit-any
  const activations: any[] = [];
  // Same patch for every row in a group, so each group is one update per chunk of dates.
  const updates = new Map<string, { ruleId: string; roomTypeId: string; patch: Record<string, unknown>; dates: string[] }>();
  const queueUpdate = (ruleId: string, roomTypeId: string, patch: Record<string, unknown>, stayDate: string) => {
    const key = `${ruleId}|${roomTypeId}|${JSON.stringify(patch)}`;
    let group = updates.get(key);
    if (!group) {
      group = { ruleId, roomTypeId, patch, dates: [] };
      updates.set(key, group);
    }
    group.dates.push(stayDate);
  };

  // deno-lint-ignore no-explicit-any
  const writeRows = async (rows: any[], write: (chunk: any[]) => PromiseLike<{ error: unknown }>) => {
    for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
      const chunk = rows.slice(i, i + WRITE_CHUNK);
      const { error } = await write(chunk);
      if (!error || chunk.length === 1) continue;
      for (const row of chunk) await write([row]);
    }
  };

  return {
    state(ruleId, stayDate, roomTypeId) {
      return states.get(`${ruleId}|${stayDate}|${roomTypeId}`) ?? null;
    },
    activate(rule, hotelId, stayDate, roomTypeId, metrics, evalTs, suppressedAt, supportsSuppression) {
      events.push(transitionEventRow(rule, hotelId, stayDate, roomTypeId, "activate", metrics, evalTs));
      activations.push(activationRow(rule, stayDate, roomTypeId, evalTs, suppressedAt, supportsSuppression));
      states.set(`${rule.id}|${stayDate}|${roomTypeId}`, { is_active: true });
    },
    deactivate(rule, hotelId, stayDate, roomTypeId, metrics, evalTs, supportsSuppression) {
      events.push(transitionEventRow(rule, hotelId, stayDate, roomTypeId, "deactivate", metrics, evalTs));
      queueUpdate(rule.id, roomTypeId, deactivationPatch(evalTs, supportsSuppression), stayDate);
      states.set(`${rule.id}|${stayDate}|${roomTypeId}`, { is_active: false });
    },
    touch(ruleId, stayDate, roomTypeId, evalTs) {
      queueUpdate(ruleId, roomTypeId, { last_evaluated_at: evalTs }, stayDate);
    },
    async flush() {
      await writeRows(events, (chunk) =>
        supabase.from("ladder_transition_event").insert(chunk),
      );
      await writeRows(activations, (chunk) =>
        supabase.from("ladder_rule_state").upsert(chunk, { onConflict: "rule_id,stay_date,room_type_id" }),
      );
      for (const group of updates.values()) {
        for (let i = 0; i < group.dates.length; i += KEY_CHUNK) {
          const dates = group.dates.slice(i, i + KEY_CHUNK);
          const { error } = await supabase
            .from("ladder_rule_state")
            .update(group.patch)
            .eq("rule_id", group.ruleId)
            .eq("room_type_id", group.roomTypeId)
            .in("stay_date", dates);
          if (!error || dates.length === 1) continue;
          for (const d of dates) {
            await supabase
              .from("ladder_rule_state")
              .update(group.patch)
              .eq("rule_id", group.ruleId)
              .eq("room_type_id", group.roomTypeId)
              .eq("stay_date", d);
          }
        }
      }
      events.length = 0;
      activations.length = 0;
      updates.clear();
    },
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
  await supabase
    .from("ladder_transition_event")
    .insert(transitionEventRow(rule, hotelId, stayDate, roomTypeId, "activate", metrics, evalTs));

  await supabase
    .from("ladder_rule_state")
    .upsert(activationRow(rule, stayDate, roomTypeId, evalTs, suppressedAt, supportsSuppression), {
      onConflict: "rule_id,stay_date,room_type_id",
    });
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
  await supabase
    .from("ladder_transition_event")
    .insert(transitionEventRow(rule, hotelId, stayDate, roomTypeId, "deactivate", metrics, evalTs));

  await supabase
    .from("ladder_rule_state")
    .update(deactivationPatch(evalTs, supportsSuppression))
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
