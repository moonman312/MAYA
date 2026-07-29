/**
 * Pickup rule evaluation — Implementation Guide §7.3, §8, §11 steps 7-8.
 *
 * Event-based with baseline reset. Per-room competition with deterministic
 * 6-level tie-breaking.
 */

import type { EngineRule } from "@/types/domain";
import type { SupabaseClient } from "@supabase/supabase-js";
import { conditionCount } from "./conditions";
import type { PickupCandidate } from "./types";

/* ── Baseline computation (§8) ────────────────────────────────── */

/**
 * §5.4 / §8: compute the baseline timestamp for a pickup rule.
 *
 * baseline_ts = max(last_event_applied_at, now - pickup_window_days)
 */
export async function computeBaselineTs(
  supabase: SupabaseClient,
  rule: EngineRule,
  stayDate: string,
  evalTs: string,
): Promise<string | null> {
  const windowDays = rule.condition.pickup_window_days ?? 3;
  const windowStart = new Date(evalTs);
  windowStart.setDate(windowStart.getDate() - windowDays);
  const windowStartTs = windowStart.toISOString();

  const { data: lastEvent } = await supabase
    .from("pickup_event")
    .select("applied_at")
    .eq("rule_id", rule.id)
    .eq("stay_date", stayDate)
    .is("retired_at", null)
    .order("applied_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!lastEvent) {
    return windowStartTs;
  }

  const lastTs = new Date(lastEvent.applied_at);
  const windowTs = new Date(windowStartTs);
  return lastTs > windowTs ? lastEvent.applied_at : windowStartTs;
}

/* ── Per-room competition (§7.3) ──────────────────────────────── */

export function basePriceKey(stayDate: string, roomTypeId: string): string {
  return `${stayDate}|${roomTypeId}`;
}

function normalizedAdjustment(rule: EngineRule, basePrice: number): number {
  if (rule.action_type === "percent") {
    return Math.abs((rule.action_value / 100) * basePrice);
  }
  return Math.abs(rule.action_value);
}

/**
 * Select one winner per scope key using the deterministic 6-level ordering.
 */
export function selectPickupWinner(
  candidates: PickupCandidate[],
  basePrices: Map<string, number>,
): PickupCandidate | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const sorted = [...candidates].sort((a, b) => {
    const priDiff = b.rule.priority - a.rule.priority;
    if (priDiff !== 0) return priDiff;

    const specDiff = conditionCount(b.rule) - conditionCount(a.rule);
    if (specDiff !== 0) return specDiff;

    const aThresh = a.rule.condition.pickup_threshold ?? 0;
    const bThresh = b.rule.condition.pickup_threshold ?? 0;
    const aOp = a.rule.condition.pickup_operator;
    if (aOp === "gt") {
      if (bThresh !== aThresh) return bThresh - aThresh;
    } else if (aOp === "lt") {
      if (aThresh !== bThresh) return aThresh - bThresh;
    }

    const baseA = basePrices.get(basePriceKey(a.stay_date, a.affected_room_type_id)) ?? 100;
    const baseB = basePrices.get(basePriceKey(b.stay_date, b.affected_room_type_id)) ?? 100;
    const aAdj = normalizedAdjustment(a.rule, baseA);
    const bAdj = normalizedAdjustment(b.rule, baseB);
    if (bAdj !== aAdj) return bAdj - aAdj;

    const aCreated = new Date(a.rule.created_at).getTime();
    const bCreated = new Date(b.rule.created_at).getTime();
    if (aCreated !== bCreated) return aCreated - bCreated;

    return a.rule.id < b.rule.id ? -1 : a.rule.id > b.rule.id ? 1 : 0;
  });

  return sorted[0];
}

/**
 * §14 — deterministic tie-break explanation vs the winning candidate.
 */
export function pickupTieBreakTrace(winner: PickupCandidate, other: PickupCandidate, basePrices: Map<string, number>): string[] {
  const trace: string[] = [];
  if (winner.rule.priority !== other.rule.priority) {
    trace.push(`priority: ${winner.rule.priority} beats ${other.rule.priority}`);
    return trace;
  }
  trace.push(`priority: tie at ${winner.rule.priority}`);

  const wSpec = conditionCount(winner.rule);
  const oSpec = conditionCount(other.rule);
  if (wSpec !== oSpec) {
    trace.push(`specificity: ${wSpec} conditions beats ${oSpec}`);
    return trace;
  }
  trace.push(`specificity: tie at ${wSpec}`);

  const wTh = winner.rule.condition.pickup_threshold ?? 0;
  const oTh = other.rule.condition.pickup_threshold ?? 0;
  const op = winner.rule.condition.pickup_operator;
  if (op === "gt" && wTh !== oTh) {
    trace.push(`pickup_threshold(gt): ${wTh} beats ${oTh}`);
    return trace;
  }
  if (op === "lt" && wTh !== oTh) {
    trace.push(`pickup_threshold(lt): stricter is lower; ${wTh} beats ${oTh}`);
    return trace;
  }
  trace.push(`pickup_threshold: tie`);

  const baseW = basePrices.get(basePriceKey(winner.stay_date, winner.affected_room_type_id)) ?? 100;
  const baseO = basePrices.get(basePriceKey(other.stay_date, other.affected_room_type_id)) ?? 100;
  const adjW = normalizedAdjustment(winner.rule, baseW);
  const adjO = normalizedAdjustment(other.rule, baseO);
  if (adjW !== adjO) {
    trace.push(`normalized_adjustment: ${adjW.toFixed(2)} beats ${adjO.toFixed(2)}`);
    return trace;
  }
  trace.push(`normalized_adjustment: tie`);

  const wCr = new Date(winner.rule.created_at).getTime();
  const oCr = new Date(other.rule.created_at).getTime();
  if (wCr !== oCr) {
    trace.push(`created_at: older wins (${winner.rule.created_at} vs ${other.rule.created_at})`);
    return trace;
  }
  trace.push(`created_at: tie`);

  trace.push(`rule.id: ${winner.rule.id} beats ${other.rule.id}`);
  return trace;
}

/* ── Event insertion (§7.3, §11 step 8) ──────────────────────── */

export async function insertPickupEvent(
  supabase: SupabaseClient,
  candidate: PickupCandidate,
  hotelId: string,
): Promise<boolean> {
  const { error } = await supabase.from("pickup_event").insert({
    hotel_id: hotelId,
    rule_id: candidate.rule.id,
    rule_version: candidate.rule.version,
    stay_date: candidate.stay_date,
    affected_room_type_id: candidate.affected_room_type_id,
    baseline_start_ts: candidate.baseline_ts,
    baseline_end_ts: candidate.eval_ts,
    signal_booked_units_start: candidate.signal_booked_units_start,
    signal_booked_units_end: candidate.signal_booked_units_end,
    signal_booked_revenue_start: candidate.signal_booked_revenue_start,
    signal_booked_revenue_end: candidate.signal_booked_revenue_end,
    applied_at: candidate.eval_ts,
    retired_at: null,
    action_kind: candidate.rule.action_type,
    action_direction: candidate.rule.action_direction,
    action_value: candidate.rule.action_value,
  });

  return !error;
}

export type PickupPassOutcome = {
  winners: PickupCandidate[];
  losers: PickupCandidate[];
  idempotent_skips: PickupCandidate[];
};

/**
 * Run the full pickup pass: group by (hotel, stay_date, affected_room_type),
 * compete, insert winners. Per-run idempotency via `insertedKeys`.
 */
export async function runPickupPass(
  supabase: SupabaseClient,
  candidates: PickupCandidate[],
  hotelId: string,
  insertedKeys: Set<string>,
  basePrices: Map<string, number>,
): Promise<PickupPassOutcome> {
  const groups = new Map<string, PickupCandidate[]>();
  for (const c of candidates) {
    const key = `${hotelId}|${c.stay_date}|${c.affected_room_type_id}`;
    const group = groups.get(key) ?? [];
    group.push(c);
    groups.set(key, group);
  }

  const winners: PickupCandidate[] = [];
  const losers: PickupCandidate[] = [];
  const idempotent_skips: PickupCandidate[] = [];

  for (const [, group] of groups) {
    const winner = selectPickupWinner(group, basePrices);
    if (!winner) continue;

    const idKey = `${winner.rule.id}|${winner.stay_date}|${winner.affected_room_type_id}`;
    if (insertedKeys.has(idKey)) {
      idempotent_skips.push(winner);
      for (const c of group) {
        if (c !== winner) losers.push(c);
      }
      continue;
    }

    const inserted = await insertPickupEvent(supabase, winner, hotelId);
    if (inserted) {
      insertedKeys.add(idKey);
      winners.push(winner);
      for (const c of group) {
        if (c !== winner) losers.push(c);
      }
    } else {
      idempotent_skips.push(winner);
      for (const c of group) {
        if (c !== winner) losers.push(c);
      }
    }
  }

  return { winners, losers, idempotent_skips };
}

/**
 * Retire pickup events whose triggering bookings have gone away.
 *
 * A pickup event is a frozen decision: it fired because bookings for a stay
 * date jumped, and it keeps adjusting the price until the stay date passes.
 * That is right while the demand is real, but when the bookings behind it
 * cancel, the event goes on holding a price up (or down) on evidence that no
 * longer exists — and unlike a ladder rule it has no path back, because
 * nothing re-checks it.
 *
 * The bar is deliberately high: retire only when bookings have fallen all
 * the way back to where they were before the event fired. A cancellation or
 * two out of a genuine surge is noise and must not undo the correction.
 *
 * Nothing is lost by retiring. The observation engine recomputes pace from
 * current data every run, so a date with real remaining momentum simply
 * triggers again once its cooldown clears.
 */
export async function retireUndonePickupEvents(
  supabase: SupabaseClient,
  hotelId: string,
  rules: EngineRule[],
  snapshotTs: string,
  now: string,
): Promise<number> {
  const { data: events } = await supabase
    .from("pickup_event")
    .select("id, rule_id, stay_date, signal_booked_units_start")
    .eq("hotel_id", hotelId)
    .is("retired_at", null);
  if (!events || events.length === 0) return 0;

  // Current booked units come from the snapshot this run just wrote, so the
  // comparison uses exactly the numbers the rest of the run reasoned about.
  const { data: snapRows } = await supabase
    .from("stay_date_snapshot")
    .select("stay_date, room_type_id, booked_units")
    .eq("hotel_id", hotelId)
    .eq("snapshot_ts", snapshotTs);
  const bookedByCell = new Map<string, number>();
  for (const s of snapRows ?? []) {
    bookedByCell.set(`${s.stay_date}|${s.room_type_id}`, Number(s.booked_units ?? 0));
  }

  const signalRoomTypesByRule = new Map(rules.map((r) => [r.id, r.signal_room_type_ids]));

  const undone: string[] = [];
  for (const ev of events) {
    const signalRoomTypes = signalRoomTypesByRule.get(String(ev.rule_id));
    // A rule that is gone or out of scope this run tells us nothing about
    // whether its trigger still holds; leave those alone.
    if (!signalRoomTypes || signalRoomTypes.length === 0) continue;

    let current = 0;
    let sawAnyCell = false;
    for (const rtId of signalRoomTypes) {
      const cell = bookedByCell.get(`${ev.stay_date}|${rtId}`);
      if (cell === undefined) continue;
      sawAnyCell = true;
      current += cell;
    }
    if (!sawAnyCell) continue;

    if (current <= Number(ev.signal_booked_units_start ?? 0)) {
      undone.push(String(ev.id));
    }
  }

  if (undone.length === 0) return 0;
  await supabase.from("pickup_event").update({ retired_at: now }).in("id", undone);
  return undone.length;
}
