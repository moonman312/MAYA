/**
 * Ladder rule evaluation — Implementation Guide §7.2, §11 step 6.
 * Deno-portable copy of src/lib/engine/ladder.ts (import paths only differ).
 *
 * Stateful, transition-based evaluation. For each (ladder rule, stay_date,
 * affected_room_type), persists is_active state and emits transition events.
 * A change that is on stays on while the rule's conditions hold; the rule's
 * "undo on cancellation" box decides whether cancellations can switch it off
 * (ladderConditionsHold in conditions.ts). A change made by an older version
 * of the rule is judged on every condition of the edited one: an edit is
 * never held on what the box keeps. If they hold, the change becomes the
 * edited version's, with its adjustment; if not, it comes off.
 *
 * SKIP (the owner switched the rule on, or saved it, with "Skip price
 * adjustments"; pricing_rules.skip_at). On the days the popup showed, the
 * save marks each row the rule was about to change, so its part in the
 * price is held as it is until the rule stops being true there and then
 * becomes true again (ladder_rule_state.skip_state, with the skip_at that
 * set it):
 *   - held: on, with no change on the price, where the rule was about to
 *     adjust. It stays so while the rule is true, and goes off (moving no
 *     price) once it isn't, so the next time the rule is true it adjusts.
 *   - carried: a change already on the price, at its amount, where the
 *     rule (as edited) was about to move it to its new amount. It stays
 *     while the rule is true, and once it isn't it is kept.
 *   - kept: a change already on the price, at its amount, where the rule
 *     was about to take it off. It stays until the rule is true there, and
 *     then moves to the rule's amount and carries on as any change of it.
 * "True" is the whole rule, whatever its undo box says: the box keeps a
 * change of the rule on the price through cancellations, and a Skip's hold
 * is not one (ruleConditionsMatch, never ladderConditionsHold).
 * Every other row works as Apply would have it. A marker from an older Skip
 * (the owner applied since) is read as what Apply means: a held row as off,
 * a kept or carried change as one from before an edit.
 */

import type { EngineRule } from "./domain.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ladderConditionsHold, ruleConditionsMatch } from "./conditions.ts";
import { MIGRATIONS, fetchAllRows, filterNights, isMissingColumnError, type NightSet } from "./snapshots.ts";
import type { AdjustmentSpec, LadderTransitionAction, RuleMetrics } from "./types.ts";

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
  let priorRow: LadderState | null;
  if (batch) {
    priorRow = batch.state(rule.id, stayDate, affectedRoomTypeId);
  } else {
    const { data } = await supabase
      .from("ladder_rule_state")
      .select("is_active, rule_version")
      .eq("rule_id", rule.id)
      .eq("stay_date", stayDate)
      .eq("room_type_id", affectedRoomTypeId)
      .maybeSingle();
    priorRow = data;
  }

  const wasActive = priorRow?.is_active ?? false;
  const rowExists = priorRow != null;
  const marker = skipMarkerOf(priorRow, rule);
  let transition: LadderTransitionAction = "noop";

  if (marker?.current && marker.kind === "held") {
    // Left alone at the Skip: no change on the price while the rule is true.
    // Once it isn't, off, which moves no price; its next hold is new. Judged
    // on the whole rule whatever the undo box says: the box keeps a change
    // on the price, and a held row has none.
    if (!ruleConditionsMatch(rule, metrics)) {
      transition = "deactivate";
      if (batch) {
        batch.deactivate(rule, hotelId, stayDate, affectedRoomTypeId, metrics, evalTs, supportsSuppression, { clearSkip: true, hadEffect: false });
      } else {
        await deactivateLadder(supabase, rule, hotelId, stayDate, affectedRoomTypeId, metrics, evalTs, supportsSuppression, true);
      }
    }
    return ladderResult(rule, stayDate, affectedRoomTypeId, transition, metrics);
  }

  if (marker?.current && marker.kind === "carried") {
    // A change left at its old amount by the Skip, where the edited rule was
    // true: it stays once the rule stops being true (whatever the undo box
    // says, as the owner left it there), now waiting for it to be true
    // again. No price moves.
    if (!ruleConditionsMatch(rule, metrics)) {
      if (batch) batch.markKept(rule, stayDate, affectedRoomTypeId);
      else {
        await supabase
          .from("ladder_rule_state")
          .update({ skip_state: "kept" })
          .eq("rule_id", rule.id)
          .eq("stay_date", stayDate)
          .eq("room_type_id", affectedRoomTypeId);
      }
    }
    return ladderResult(rule, stayDate, affectedRoomTypeId, transition, metrics);
  }

  if (marker?.current && marker.kind === "kept") {
    // A change left on at its old amount by the Skip, where the rule was
    // not true then: once the rule is true, it is the rule's change.
    if (ruleConditionsMatch(rule, metrics)) {
      const moves = priorRow?.amount !== amountOf(rule);
      if (moves) transition = "activate";
      if (batch) batch.restampKept(rule, hotelId, stayDate, affectedRoomTypeId, metrics, evalTs);
      else {
        await supabase
          .from("ladder_transition_event")
          .insert(transitionEventRow(rule, hotelId, stayDate, affectedRoomTypeId, "activate", metrics, evalTs));
        await supabase
          .from("ladder_rule_state")
          .update({ ...restampPatch(rule), ...CLEAR_SKIP })
          .eq("rule_id", rule.id)
          .eq("stay_date", stayDate)
          .eq("room_type_id", affectedRoomTypeId);
      }
    }
    return ladderResult(rule, stayDate, affectedRoomTypeId, transition, metrics);
  }

  // A held row from an older Skip (applied since) is no change on the price:
  // it reads as off. A kept or carried one reads as a change from before an
  // edit.
  const heldStale = marker?.kind === "held";
  const keptStale = marker?.kind === "kept" || marker?.kind === "carried";
  const active = wasActive && !heldStale;
  // A change on from before the rule was edited: the edited rule's
  // conditions all have to hold.
  const edited =
    active && (keptStale || (priorRow?.rule_version != null && Number(priorRow.rule_version) !== rule.version));
  // A change already on is kept while its conditions hold, except that an
  // unticked rule is never switched off by cancellations (ladderConditionsHold).
  const matches = active && !edited ? ladderConditionsHold(rule, metrics) : ruleConditionsMatch(rule, metrics);

  // Still true after the edit: the change is the edited rule's from now on,
  // its adjustment included, and what the box keeps applies to it again.
  if (matches && edited) {
    if (batch) batch.restamp(rule, stayDate, affectedRoomTypeId, keptStale);
    else {
      await supabase
        .from("ladder_rule_state")
        .update(keptStale ? { ...restampPatch(rule), ...CLEAR_SKIP } : restampPatch(rule))
        .eq("rule_id", rule.id)
        .eq("stay_date", stayDate)
        .eq("room_type_id", affectedRoomTypeId);
    }
  }

  if (matches && !active) {
    transition = "activate";
    // Only a row that never existed can have missed the route's stamp. An
    // existing inactive row has a history: whatever held at the override was
    // already handled, so its re-activation is a fresh trigger. A row held by
    // an older Skip was on when a price was typed over it: that stamp stays.
    const suppressedAt =
      heldStale && supportsSuppression && priorRow?.suppressed_at
        ? priorRow.suppressed_at
        : supportsSuppression && !rowExists && override && (await override.heldAtOverride())
          ? override.set_at
          : null;
    if (batch) {
      batch.activate(rule, hotelId, stayDate, affectedRoomTypeId, metrics, evalTs, suppressedAt, supportsSuppression, heldStale);
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
      heldStale,
    );
  } else if (!matches && active) {
    transition = "deactivate";
    if (batch) {
      batch.deactivate(rule, hotelId, stayDate, affectedRoomTypeId, metrics, evalTs, supportsSuppression, {
        clearSkip: keptStale,
        hadEffect: !(supportsSuppression && priorRow?.suppressed_at),
      });
    } else await deactivateLadder(
      supabase,
      rule,
      hotelId,
      stayDate,
      affectedRoomTypeId,
      metrics,
      evalTs,
      supportsSuppression,
      keptStale,
    );
  }
  // A state that did not change is not written. Stamping last_evaluated_at on
  // every held or idle row rewrote thousands of rows a tick on a large
  // property (rules x nights x room types, every five minutes) for a column
  // only the debug endpoint reads; the run log says when the hotel last ran.

  return ladderResult(rule, stayDate, affectedRoomTypeId, transition, metrics);
}

function ladderResult(
  rule: EngineRule,
  stayDate: string,
  roomTypeId: string,
  transition: LadderTransitionAction,
  metrics: RuleMetrics,
): LadderPassResult {
  return {
    rule_id: rule.id,
    rule_version: rule.version,
    stay_date: stayDate,
    room_type_id: roomTypeId,
    transition,
    metrics,
    action_kind: rule.action_type,
    action_direction: rule.action_direction,
    action_value: rule.action_value,
  };
}

/**
 * A (rule, night, room type)'s state as the pass reads it: on or off, which
 * version of the rule it is from, whether a typed price suppressed it, and
 * the owner's Skip marker (see the header), where the columns exist.
 */
export type LadderState = {
  is_active: boolean;
  rule_version?: number | null;
  suppressed_at?: string | null;
  skip_state?: SkipState | null;
  skip_at?: string | null;
  /** The row's adjustment, `kind|direction|value` (read with the Skip columns). */
  amount?: string;
};

/** The owner's Skip marker on a ladder row (see the header). */
export type SkipState = "held" | "kept" | "carried";

const SKIP_STATES: readonly string[] = ["held", "kept", "carried"];

/** A rule's adjustment as LadderState.amount spells it. */
export function amountOf(rule: Pick<EngineRule, "action_type" | "action_direction" | "action_value">): string {
  return `${rule.action_type}|${rule.action_direction}|${Number(rule.action_value)}`;
}

/** Two timestamps naming the same instant, however each is spelled. */
export function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = Date.parse(a);
  const y = Date.parse(b);
  return Number.isFinite(x) && x === y;
}

/**
 * The owner's Skip marker on an active row, and whether it belongs to the
 * rule's current Skip (pricing_rules.skip_at). Null for a row with none.
 */
export function skipMarkerOf(
  prior: LadderState | null | undefined,
  rule: Pick<EngineRule, "skip_at">,
): { kind: SkipState; current: boolean } | null {
  if (!prior?.is_active || !prior.skip_state || !SKIP_STATES.includes(prior.skip_state)) return null;
  return { kind: prior.skip_state, current: sameInstant(prior.skip_at, rule.skip_at) };
}

/** Takes the owner's Skip marker off a row (written only where the row had one). */
const CLEAR_SKIP = { skip_state: null, skip_at: null } as const;

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
  clearSkip = false,
) {
  return {
    ...(clearSkip ? CLEAR_SKIP : {}),
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

/** A change still on after an edit, made the edited version's: its version and adjustment. */
function restampPatch(rule: EngineRule) {
  return {
    rule_version: rule.version,
    action_kind: rule.action_type,
    action_direction: rule.action_direction,
    action_value: rule.action_value,
  };
}

function deactivationPatch(evalTs: string, supportsSuppression: boolean, clearSkip = false) {
  return {
    ...(clearSkip ? CLEAR_SKIP : {}),
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
 * row alone.
 *
 * A row that still fails makes flush throw, once every other write has been
 * tried. Prices assembled on top of a half-written pass are wrong in a way
 * nothing downstream can see (a deactivation that did not land keeps its
 * effect on the price while the change log says the rule let go), so the run
 * fails before it publishes and the last good prices stay in place. The next
 * run reads the state that did land and decides the rest again.
 */
export type LadderPassBatch = {
  state: (ruleId: string, stayDate: string, roomTypeId: string) => LadderState | null;
  /** The rule's rows read at the start that are on now, with where they are (for rows the pass no longer reaches). */
  activeRows: (ruleId: string) => { stayDate: string; roomTypeId: string; state: LadderState }[];
  activate: (
    rule: EngineRule,
    hotelId: string,
    stayDate: string,
    roomTypeId: string,
    metrics: RuleMetrics,
    evalTs: string,
    suppressedAt: string | null,
    supportsSuppression: boolean,
    /** The row carried an owner's Skip marker, which the activation takes off. */
    clearSkip?: boolean,
  ) => void;
  deactivate: (
    rule: EngineRule,
    hotelId: string,
    stayDate: string,
    roomTypeId: string,
    metrics: RuleMetrics,
    evalTs: string,
    supportsSuppression: boolean,
    opts?: {
      clearSkip?: boolean;
      hadEffect?: boolean;
      /** For a row the pass no longer reaches: whether the rule is true on that night (what a Skip would hold it as). */
      holds?: boolean;
    },
  ) => void;
  /** A change still on after an edit becomes the edited version's (rule_version and its adjustment). */
  restamp: (rule: EngineRule, stayDate: string, roomTypeId: string, clearSkip?: boolean) => void;
  /** A change kept by the owner's Skip becomes the rule's own, at its amount, now the rule is true there. */
  restampKept: (
    rule: EngineRule,
    hotelId: string,
    stayDate: string,
    roomTypeId: string,
    metrics: RuleMetrics,
    evalTs: string,
  ) => void;
  /** A change the owner's Skip carried at its old amount waits, from now, for the rule to be true again (kept). No price moves. */
  markKept: (rule: EngineRule, stayDate: string, roomTypeId: string) => void;
  /**
   * The decisions queued since the batch was made, in order, as they bear on
   * prices: what a dry run lays over the effects it reads (see
   * applyLadderOps) and what the owner's Skip turns into markers.
   */
  ops: () => readonly LadderOp[];
  /** Whether the Skip columns exist (read with the state). */
  supportsSkip: boolean;
  flush: () => Promise<void>;
};

/**
 * One ladder decision, as it bears on the cell's price. `effect` on an
 * activation is false when the row is born with no change on the price (a
 * typed price already covering it). `hadEffect` says whether the row it
 * changes was moving the price before. A restamp's `amountChanges` says
 * whether the row's adjustment differs from the rule's (it moves the price
 * when the row had an effect). A deactivation's `holds`, for a row the pass
 * no longer reaches, says whether the rule is true on that night.
 */
export type LadderOp =
  | { kind: "activate"; rule: EngineRule; stayDate: string; roomTypeId: string; effect: boolean; hadEffect: boolean }
  | { kind: "deactivate"; rule: EngineRule; stayDate: string; roomTypeId: string; hadEffect: boolean; holds?: boolean }
  | { kind: "restamp"; rule: EngineRule; stayDate: string; roomTypeId: string; hadEffect: boolean; amountChanges: boolean };

export async function createLadderPassBatch(
  supabase: SupabaseClient,
  ruleIds: string[],
  firstDate: string,
  lastDate: string,
  /** The run's nights when they are not every night in the range (filterNights). */
  nights?: NightSet,
  opts: {
    /** Read suppressed_at with the state (probeSuppressionSupport). */
    supportsSuppression?: boolean;
    /** A dry run: flush writes nothing; the queued decisions stay readable through ops(). */
    dryRun?: boolean;
  } = {},
): Promise<LadderPassBatch> {
  const states = new Map<string, LadderState>();
  // The keys read for each rule, for activeRows.
  const keysByRule = new Map<string, string[]>();
  let supportsSkip = true;
  if (ruleIds.length > 0) {
    const base = "rule_id, stay_date, room_type_id, is_active, rule_version";
    // With the Skip columns, the amount too: a kept change the rule is true
    // for again moves the price only when the rule's amount differs, and a
    // Skip holds a change an edit would move to a new amount (carried).
    const columns = (skip: boolean) =>
      `${base}${opts.supportsSuppression ? ", suppressed_at" : ""}${skip ? ", skip_state, skip_at, action_kind, action_direction, action_value" : ""}`;
    const read = (ids: string[], skip: boolean) =>
      fetchAllRows(() =>
        filterNights(
          supabase.from("ladder_rule_state").select(columns(skip)).in("rule_id", ids),
          nights,
          firstDate,
          lastDate,
        )
          .order("rule_id", { ascending: true })
          .order("stay_date", { ascending: true })
          .order("room_type_id", { ascending: true }),
      );
    for (let i = 0; i < ruleIds.length; i += KEY_CHUNK) {
      const ids = ruleIds.slice(i, i + KEY_CHUNK);
      let rows;
      try {
        rows = await read(ids, supportsSkip);
      } catch (e) {
        // Before 99_supabase_migration_rule_activation_v1.sql there are no
        // Skip columns, and no rule was ever skipped: read without them.
        if (!supportsSkip || !isMissingColumnError(e)) throw e;
        supportsSkip = false;
        rows = await read(ids, false);
      }
      for (const r of rows) {
        const skipState = SKIP_STATES.includes(String(r.skip_state)) ? (r.skip_state as SkipState) : null;
        const key = `${r.rule_id}|${r.stay_date}|${r.room_type_id}`;
        const keys = keysByRule.get(String(r.rule_id));
        if (keys) keys.push(key);
        else keysByRule.set(String(r.rule_id), [key]);
        states.set(key, {
          is_active: Boolean(r.is_active),
          rule_version: r.rule_version != null ? Number(r.rule_version) : null,
          ...(opts.supportsSuppression ? { suppressed_at: r.suppressed_at != null ? String(r.suppressed_at) : null } : {}),
          ...(skipState ? { skip_state: skipState, skip_at: r.skip_at != null ? String(r.skip_at) : null } : {}),
          ...(r.action_kind != null ? { amount: `${r.action_kind}|${r.action_direction}|${Number(r.action_value)}` } : {}),
        });
      }
    }
  }

  // deno-lint-ignore no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const events: any[] = [];
  // deno-lint-ignore no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const activations: any[] = [];
  const log: LadderOp[] = [];
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
  // Whether a row that is on moves the price: not while a typed price
  // suppresses it, nor while the owner's Skip holds it.
  const movesPrice = (st: LadderState | undefined) =>
    !!st?.is_active && !st.suppressed_at && st.skip_state !== "held";

  // Row-level failures of the current flush: what failed, and the first message.
  const failures = { rows: 0, first: "" };
  const noteFailure = (what: string, error: unknown, rows = 1) => {
    failures.rows += rows;
    if (!failures.first) {
      const message = (error as { message?: unknown } | null)?.message;
      failures.first = `${what}: ${typeof message === "string" ? message : String(error)}`;
    }
  };

  // deno-lint-ignore no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const writeRows = async (what: string, rows: any[], write: (chunk: any[]) => PromiseLike<{ error: unknown }>) => {
    for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
      const chunk = rows.slice(i, i + WRITE_CHUNK);
      const { error } = await write(chunk);
      if (!error) continue;
      if (chunk.length === 1) {
        noteFailure(what, error);
        continue;
      }
      for (const row of chunk) {
        const { error: rowError } = await write([row]);
        if (rowError) noteFailure(what, rowError);
      }
    }
  };

  return {
    supportsSkip,
    state(ruleId, stayDate, roomTypeId) {
      return states.get(`${ruleId}|${stayDate}|${roomTypeId}`) ?? null;
    },
    activeRows(ruleId) {
      const out: { stayDate: string; roomTypeId: string; state: LadderState }[] = [];
      for (const key of keysByRule.get(ruleId) ?? []) {
        const state = states.get(key);
        if (!state?.is_active) continue;
        const [, stayDate, roomTypeId] = key.split("|");
        out.push({ stayDate, roomTypeId, state });
      }
      return out;
    },
    ops() {
      return log;
    },
    activate(rule, hotelId, stayDate, roomTypeId, metrics, evalTs, suppressedAt, supportsSuppression, clearSkip = false) {
      const key = `${rule.id}|${stayDate}|${roomTypeId}`;
      const hadEffect = movesPrice(states.get(key));
      events.push(transitionEventRow(rule, hotelId, stayDate, roomTypeId, "activate", metrics, evalTs));
      activations.push(activationRow(rule, stayDate, roomTypeId, evalTs, suppressedAt, supportsSuppression, clearSkip && supportsSkip));
      states.set(key, { is_active: true, rule_version: rule.version, suppressed_at: supportsSuppression ? suppressedAt : null, amount: amountOf(rule) });
      log.push({ kind: "activate", rule, stayDate, roomTypeId, effect: !(supportsSuppression && suppressedAt), hadEffect });
    },
    deactivate(rule, hotelId, stayDate, roomTypeId, metrics, evalTs, supportsSuppression, o = {}) {
      const key = `${rule.id}|${stayDate}|${roomTypeId}`;
      const hadEffect = o.hadEffect ?? movesPrice(states.get(key));
      events.push(transitionEventRow(rule, hotelId, stayDate, roomTypeId, "deactivate", metrics, evalTs));
      queueUpdate(rule.id, roomTypeId, deactivationPatch(evalTs, supportsSuppression, !!o.clearSkip && supportsSkip), stayDate);
      states.set(key, { is_active: false, rule_version: rule.version });
      log.push({ kind: "deactivate", rule, stayDate, roomTypeId, hadEffect, ...(o.holds !== undefined ? { holds: o.holds } : {}) });
    },
    restamp(rule, stayDate, roomTypeId, clearSkip = false) {
      const key = `${rule.id}|${stayDate}|${roomTypeId}`;
      const prior = states.get(key);
      queueUpdate(rule.id, roomTypeId, clearSkip && supportsSkip ? { ...restampPatch(rule), ...CLEAR_SKIP } : restampPatch(rule), stayDate);
      states.set(key, { is_active: true, rule_version: rule.version, suppressed_at: prior?.suppressed_at ?? null, amount: amountOf(rule) });
      log.push({ kind: "restamp", rule, stayDate, roomTypeId, hadEffect: movesPrice(prior), amountChanges: prior?.amount !== amountOf(rule) });
    },
    restampKept(rule, hotelId, stayDate, roomTypeId, metrics, evalTs) {
      const key = `${rule.id}|${stayDate}|${roomTypeId}`;
      const prior = states.get(key);
      // The rule acts only where its amount differs from the kept one.
      const amountChanges = prior?.amount !== amountOf(rule);
      if (amountChanges) {
        events.push(transitionEventRow(rule, hotelId, stayDate, roomTypeId, "activate", metrics, evalTs));
      }
      queueUpdate(rule.id, roomTypeId, { ...restampPatch(rule), ...CLEAR_SKIP }, stayDate);
      states.set(key, { is_active: true, rule_version: rule.version, suppressed_at: prior?.suppressed_at ?? null, amount: amountOf(rule) });
      log.push({ kind: "restamp", rule, stayDate, roomTypeId, hadEffect: movesPrice(prior), amountChanges });
    },
    markKept(rule, stayDate, roomTypeId) {
      const key = `${rule.id}|${stayDate}|${roomTypeId}`;
      const prior = states.get(key);
      if (!supportsSkip || !prior) return;
      queueUpdate(rule.id, roomTypeId, { skip_state: "kept" }, stayDate);
      states.set(key, { ...prior, skip_state: "kept" });
    },
    async flush() {
      if (opts.dryRun) {
        // Nothing is written: the decisions stay in ops() for the caller.
        events.length = 0;
        activations.length = 0;
        updates.clear();
        return;
      }
      failures.rows = 0;
      failures.first = "";
      await writeRows("ladder_transition_event", events, (chunk) =>
        supabase.from("ladder_transition_event").insert(chunk),
      );
      await writeRows("ladder_rule_state activation", activations, (chunk) =>
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
          if (!error) continue;
          if (dates.length === 1) {
            noteFailure("ladder_rule_state deactivation", error);
            continue;
          }
          for (const d of dates) {
            const { error: rowError } = await supabase
              .from("ladder_rule_state")
              .update(group.patch)
              .eq("rule_id", group.ruleId)
              .eq("room_type_id", group.roomTypeId)
              .eq("stay_date", d);
            if (rowError) noteFailure("ladder_rule_state deactivation", rowError);
          }
        }
      }
      events.length = 0;
      activations.length = 0;
      updates.clear();
      if (failures.rows > 0) {
        throw new Error(
          `Ladder writes failed for ${failures.rows} row${failures.rows === 1 ? "" : "s"}; the run stops before publishing. First: ${failures.first}`.slice(0, 300),
        );
      }
    },
  };
}

/**
 * Lays a dry run's ladder decisions (LadderPassBatch.ops) over the effects
 * read from the table, as the table would read after the pass's writes: an
 * activation that moves the price adds the rule's adjustment, a deactivation
 * takes it off, and a change kept on (an edit, or the rule true again after
 * a Skip) takes the rule's current adjustment. Each cell's effects stay in
 * rule_id order, the order the table returns them in (a canonical lowercase
 * uuid sorts as a string the way Postgres sorts its bytes).
 */
export function applyLadderOps(
  effects: Map<string, AdjustmentSpec[]>,
  ops: readonly LadderOp[],
): Map<string, AdjustmentSpec[]> {
  for (const op of ops) {
    const key = `${op.stayDate}|${op.roomTypeId}`;
    const list = (effects.get(key) ?? []).filter((e) => e.rule_id !== op.rule.id);
    const had = (effects.get(key) ?? []).some((e) => e.rule_id === op.rule.id);
    const adjustment: AdjustmentSpec = {
      rule_id: op.rule.id,
      action_kind: op.rule.action_type,
      action_direction: op.rule.action_direction,
      action_value: op.rule.action_value,
    };
    const keep = op.kind === "activate" ? op.effect : op.kind === "restamp" ? had : false;
    if (keep) {
      const at = list.findIndex((e) => e.rule_id > op.rule.id);
      list.splice(at === -1 ? list.length : at, 0, adjustment);
    }
    if (list.length > 0) effects.set(key, list);
    else effects.delete(key);
  }
  return effects;
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
  clearSkip = false,
): Promise<void> {
  await supabase
    .from("ladder_transition_event")
    .insert(transitionEventRow(rule, hotelId, stayDate, roomTypeId, "activate", metrics, evalTs));

  await supabase
    .from("ladder_rule_state")
    .upsert(activationRow(rule, stayDate, roomTypeId, evalTs, suppressedAt, supportsSuppression, clearSkip), {
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
  clearSkip = false,
): Promise<void> {
  await supabase
    .from("ladder_transition_event")
    .insert(transitionEventRow(rule, hotelId, stayDate, roomTypeId, "deactivate", metrics, evalTs));

  await supabase
    .from("ladder_rule_state")
    .update(deactivationPatch(evalTs, supportsSuppression, clearSkip))
    .eq("rule_id", rule.id)
    .eq("stay_date", stayDate)
    .eq("room_type_id", roomTypeId);
}

