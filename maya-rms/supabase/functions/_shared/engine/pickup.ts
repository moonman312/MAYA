/**
 * Event rules — Implementation Guide §7.3, §8, §11 steps 7-8.
 * Deno-portable copy of src/lib/engine/pickup.ts (import paths only differ).
 *
 * An event rule (is_pickup_rule: any rule with a pickup or Booking Speed
 * condition) fires once, and the fire keeps adjusting the night's price for
 * that room type until something takes it off. Fires stack: once a rule's
 * wait has passed on a night and room type and its condition still holds, it
 * fires again, so a raise raises again and a cut cuts again. Each fire is a
 * pickup_event row with its own fire number (fire_seq).
 *
 * WAIT (ruleWaitDays, waitAnchor). A Booking Speed rule waits its cooldown
 * (booking_speed_cooldown_days, a week when unset, never under a day); a
 * pickup count rule waits its pickup window; a rule with both waits the
 * longer. The wait runs from the newest of: this rule version's latest fire
 * on the cell that is still open or came off for cancellations, a passed
 * night or before reasons were kept; and the set_at of an open manual price
 * on the cell, for a rule that existed when the price was set. Fires taken
 * off by a manual price or an edit never start a wait.
 *
 * WHAT A RULE MEASURES. A pickup condition counts net bookings over exactly
 * its window (now minus pickup_window_days). The wait is at least that long,
 * so a window never reaches back past the rule's last fire on the cell, or
 * past a manual price set before the rule's wait began. A Booking Speed
 * condition reads the observation over its own window and needs no old
 * snapshot. After a manual price, a rule judges its full normal window,
 * bookings from before the price included.
 *
 * WHICH RULE FIRES. At most one fire per cell per run. The competition
 * (selectPickupWinner) includes rules waiting on the cell whose conditions
 * still match: if one of those ranks first, nothing fires there this run. A
 * stronger rule can always fire while a weaker one waits. A candidate is
 * dropped before the competition when it can't move the price in its own
 * direction (limitAllowsFire), and a cell the run leaves unpriced never gets
 * a fire.
 *
 * WHEN A FIRE COMES OFF. Cuts never come off for cancellations. A raise comes
 * off when the bookings behind it cancel (cancellationCrossed): for a pickup
 * raise, net bookings are back to where its window opened; for a Booking
 * Speed raise, the bookings still on the books from its frozen window are
 * back to what a night like it usually gets. Each stacked raise is tested on
 * its own numbers, and never in the run that made it. Every fire also comes
 * off when its night passes, when a manual price is set on the cell, and
 * when the rule is edited. Pausing a rule changes nothing: its fires keep
 * applying and are not tested while it is paused.
 */

import type { EngineRule, PickupCancelCheck } from "./domain.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { bookingSpeedRank, isBookingSpeed } from "../observations/booking-speed.ts";
import {
  DEFAULT_BOOKING_SPEED_COOLDOWN_DAYS,
  bookingsInFrozenWindow,
  isWithinCooldown,
  signalSetKey,
  type BookingSpeedContext,
} from "./booking-speed-provider.ts";
import { conditionCount } from "./conditions.ts";
import { pickupEffectOf, type PickupEffect } from "./pricing.ts";
import { MIGRATIONS, fetchAllRows } from "./snapshots.ts";
import { addCalendarDays } from "./timezone.ts";
import type { PickupCandidate, RuleMetrics } from "./types.ts";

const DAY_MS = 86_400_000;

/* ── Waits (§8) ───────────────────────────────────────────────── */

/**
 * Whole days an event rule waits after firing on a cell before it may fire
 * there again. A stored cooldown under a day reads as a day: with stacking, 0
 * would cut or raise every run.
 */
export function ruleWaitDays(rule: EngineRule): number {
  const c = rule.condition;
  const bookingSpeed = c.booking_speed_operator
    ? Math.max(1, c.booking_speed_cooldown_days ?? DEFAULT_BOOKING_SPEED_COOLDOWN_DAYS)
    : 0;
  const pickup = c.pickup_operator ? (c.pickup_window_days ?? 3) : 0;
  const days = Math.max(bookingSpeed, pickup);
  return days > 0 ? days : DEFAULT_BOOKING_SPEED_COOLDOWN_DAYS;
}

/**
 * Where a pickup condition's window opens: now minus pickup_window_days, in
 * milliseconds. null for a rule with no pickup condition, which reads no old
 * snapshot at all.
 */
export function baselineTsFrom(rule: EngineRule, evalTs: string): string | null {
  if (!rule.condition.pickup_operator) return null;
  const windowDays = rule.condition.pickup_window_days ?? 3;
  return new Date(Date.parse(evalTs) - windowDays * DAY_MS).toISOString();
}

/** A cell's fire history for one rule, from pickup_fire_heads. */
export type FireHead = {
  /** Highest fire_seq of any version: the next fire is one above it. */
  maxFireSeq: number;
  /** This rule version's newest fire that starts a wait, or null. */
  anchorAt: string | null;
  /** This rule version's fires that count toward the owner alert: open, or taken off for cancellations. */
  counted: number;
  /** The newest of those. */
  lastCountedAt: string | null;
};

export function fireHeadKey(ruleId: string, stayDate: string, roomTypeId: string): string {
  return `${ruleId}|${stayDate}|${roomTypeId}`;
}

const HEADS_PAGE = 1000;

/**
 * FireHead per `rule_id|stay_date|room_type_id` for the given event rules
 * over a range of nights, from pickup_fire_heads
 * (99_supabase_migration_pickup_event_stacking_v1.sql), paged. The anchor and
 * counts are the ones of each rule's current version.
 *
 * Throws on any failure, a missing function included: with no fire history
 * every rule would look unfired and stack on every run.
 */
export async function loadPickupFireHeads(
  supabase: SupabaseClient,
  hotelId: string,
  rules: EngineRule[],
  firstDate: string,
  lastDate: string,
): Promise<Map<string, FireHead>> {
  const out = new Map<string, FireHead>();
  if (rules.length === 0) return out;
  const versionOf = new Map(rules.map((r) => [r.id, r.version]));
  for (let from = 0; ; from += HEADS_PAGE) {
    const { data, error } = await supabase
      .rpc("pickup_fire_heads", {
        p_hotel_id: hotelId,
        p_rule_ids: rules.map((r) => r.id),
        p_from: firstDate,
        p_to: lastDate,
      })
      .order("stay_date", { ascending: true })
      .order("rule_id", { ascending: true })
      .order("affected_room_type_id", { ascending: true })
      .order("rule_version", { ascending: true })
      .range(from, from + HEADS_PAGE - 1);
    if (error) {
      throw new Error(
        `Failed to load rule fire history (run ${MIGRATIONS.pickupStacking} before deploying): ${error.message}`,
      );
    }
    if (!Array.isArray(data)) throw new Error("Failed to load rule fire history: no rows came back");
    for (const r of data as Record<string, unknown>[]) {
      const key = fireHeadKey(String(r.rule_id), String(r.stay_date), String(r.affected_room_type_id));
      const head = out.get(key) ?? { maxFireSeq: 0, anchorAt: null, counted: 0, lastCountedAt: null };
      head.maxFireSeq = Math.max(head.maxFireSeq, Number(r.max_fire_seq ?? 0));
      if (Number(r.rule_version) === versionOf.get(String(r.rule_id))) {
        head.anchorAt = r.anchor_at != null ? String(r.anchor_at) : null;
        head.counted = Number(r.counted_fires ?? 0);
        head.lastCountedAt = r.last_counted_at != null ? String(r.last_counted_at) : null;
      }
      out.set(key, head);
    }
    if (data.length < HEADS_PAGE) break;
  }
  return out;
}

/**
 * When the rule's wait on a cell started: its last fire that starts a wait,
 * or the open manual price's set_at when that is later and the rule already
 * existed when the price was set. A rule created after the price is not held
 * by it. null means no wait.
 */
export function waitAnchor(
  rule: EngineRule,
  head: FireHead | undefined,
  manualPrice: { set_at: string } | undefined,
): string | null {
  let anchor = head?.anchorAt ?? null;
  if (manualPrice && Date.parse(rule.created_at) <= Date.parse(manualPrice.set_at)) {
    if (anchor === null || Date.parse(manualPrice.set_at) > Date.parse(anchor)) anchor = manualPrice.set_at;
  }
  return anchor;
}

/** Still waiting: less than `waitDays` whole days since the anchor. */
export function isWaiting(anchor: string | null, nowIso: string, waitDays: number): boolean {
  return isWithinCooldown(anchor, nowIso, waitDays);
}

/**
 * Which cancellation test can take a fire off, decided when it fires.
 *
 * Cuts: none, ever. A raise qualifies for the net test when the rule fires on
 * "pickup more than" a threshold of 0 or more and bookings grew over its
 * window; for the window test when the rule fires on Booking Speed at least
 * (or exactly) Faster and the window had more bookings than usual. A raise
 * whose trigger is "less than", "slower" or "normal" was not caused by
 * bookings, so cancellations never undo it.
 */
export function cancelCheckFor(rule: EngineRule, metrics: RuleMetrics): PickupCancelCheck {
  if (rule.action_direction !== "increase") return "none";
  const c = rule.condition;
  const net =
    c.pickup_operator === "gt" &&
    (c.pickup_threshold ?? 0) >= 0 &&
    (metrics.signal_booked_units_now ?? 0) > (metrics.signal_booked_units_baseline ?? 0);
  const bs = metrics.booking_speed;
  const window =
    (c.booking_speed_operator === "at_least" || c.booking_speed_operator === "is") &&
    isBookingSpeed(c.booking_speed_level) &&
    bookingSpeedRank(c.booking_speed_level) >= 1 &&
    bs != null &&
    bs.recent > bs.expected;
  if (net && window) return "either";
  if (net) return "net_units";
  if (window) return "window_bookings";
  return "none";
}

/**
 * The fire a rule would make on a cell from this run's metrics. A rule with
 * no pickup condition measures no window: its booked units at the start and
 * end are both now, and baseline_ts is informational.
 */
export function candidateFor(input: {
  rule: EngineRule;
  metrics: RuleMetrics;
  stayDate: string;
  roomTypeId: string;
  now: string;
  localDate: string;
  baselineTs: string | null;
  head: FireHead | undefined;
}): PickupCandidate {
  const { rule, metrics: m, baselineTs, now } = input;
  const bs = m.booking_speed ?? null;
  const measuresWindow = baselineTs !== null;
  const bsWindowDays = bs?.window_days ?? rule.condition.booking_speed_window_days ?? 7;
  return {
    rule,
    metrics: m,
    stay_date: input.stayDate,
    baseline_ts: baselineTs ?? new Date(Date.parse(now) - bsWindowDays * DAY_MS).toISOString(),
    affected_room_type_id: input.roomTypeId,
    eval_ts: now,
    signal_booked_units_start: measuresWindow ? (m.signal_booked_units_baseline ?? 0) : (m.signal_booked_units_now ?? 0),
    signal_booked_units_end: m.signal_booked_units_now ?? 0,
    signal_booked_revenue_start: measuresWindow
      ? (m.signal_booked_revenue_baseline ?? 0)
      : (m.signal_booked_revenue_now ?? 0),
    signal_booked_revenue_end: m.signal_booked_revenue_now ?? 0,
    fire_seq: (input.head?.maxFireSeq ?? 0) + 1,
    cancel_check: cancelCheckFor(rule, m),
    window_from: bs ? addCalendarDays(input.localDate, -(bs.window_days - 1)) : null,
    window_to: bs ? input.localDate : null,
    window_bookings_at_fire: bs ? bs.recent : null,
    window_expected_at_fire: bs ? Math.round(bs.expected * 100) / 100 : null,
    signal_set_key: signalSetKey(rule.signal_room_type_ids),
  };
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

    // Thresholds are only comparable when both sides share the same
    // operator — "greater than 10" and "less than 2" aren't points on the
    // same number line, so ranking one against the other isn't well
    // defined. Branching on `a`'s operator alone made the comparator
    // asymmetric (compare(P,Q) and compare(Q,P) could both claim to go
    // first), so the winner — and the sign of the price move — depended on
    // unspecified DB row order. A booking-speed rule's null pickup_operator
    // falls through the same way, for the same reason.
    const aOp = a.rule.condition.pickup_operator;
    const bOp = b.rule.condition.pickup_operator;
    if (aOp != null && aOp === bOp) {
      const aThresh = a.rule.condition.pickup_threshold ?? 0;
      const bThresh = b.rule.condition.pickup_threshold ?? 0;
      if (aThresh !== bThresh) {
        return aOp === "gt" ? bThresh - aThresh : aThresh - bThresh;
      }
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

  const wOp = winner.rule.condition.pickup_operator;
  const oOp = other.rule.condition.pickup_operator;
  // Only claim a threshold win when both sides share the same operator —
  // see selectPickupWinner's comment. Different (or null) operators aren't
  // comparable, so the trace says so honestly instead of ranking numbers
  // that don't mean the same thing.
  if (wOp != null && wOp === oOp) {
    const wTh = winner.rule.condition.pickup_threshold ?? 0;
    const oTh = other.rule.condition.pickup_threshold ?? 0;
    if (wTh !== oTh) {
      trace.push(
        wOp === "gt"
          ? `pickup_threshold(gt): ${wTh} beats ${oTh}`
          : `pickup_threshold(lt): stricter is lower; ${wTh} beats ${oTh}`,
      );
      return trace;
    }
    trace.push(`pickup_threshold: tie`);
  } else {
    trace.push(`pickup_threshold: not comparable (different operators)`);
  }

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

/* ── Fire insertion (§7.3, §11 step 8) ───────────────────────── */

/** The unique index that stops two runs recording the same fire. */
export const FIRE_UNIQUE_INDEX = "uq_pickup_event_fire";

/**
 * "inserted" carries the new fire as it applies to the price. A unique
 * violation on uq_pickup_event_fire is "concurrent_fire": an overlapping run
 * read the same fire history and recorded this fire number first, so this
 * one must not be counted or priced as its own. "write_failed" is anything
 * else: a fire that did not happen and must never read as either.
 */
export type PickupInsertResult =
  | { status: "inserted"; effect: PickupEffect }
  | { status: "concurrent_fire" }
  | { status: "write_failed" };

const FIRE_COLUMNS = "id, rule_id, applied_at, fire_seq, action_kind, action_direction, action_value";

export async function insertPickupEvent(
  supabase: SupabaseClient,
  candidate: PickupCandidate,
  hotelId: string,
): Promise<PickupInsertResult> {
  const { data, error } = await supabase
    .from("pickup_event")
    .insert({
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
      retired_reason: null,
      action_kind: candidate.rule.action_type,
      action_direction: candidate.rule.action_direction,
      action_value: candidate.rule.action_value,
      fire_seq: candidate.fire_seq,
      cancel_check: candidate.cancel_check,
      window_from: candidate.window_from,
      window_to: candidate.window_to,
      window_bookings_at_fire: candidate.window_bookings_at_fire,
      window_expected_at_fire: candidate.window_expected_at_fire,
      signal_set_key: candidate.signal_set_key,
    })
    .select(FIRE_COLUMNS)
    .single();

  if (error) {
    if (error.code === "23505" && String(error.message ?? "").includes(FIRE_UNIQUE_INDEX)) {
      return { status: "concurrent_fire" };
    }
    return { status: "write_failed" };
  }
  if (data) return { status: "inserted", effect: pickupEffectOf(data) };
  // Written, but the row did not come back: read it by its fire number.
  const { data: row } = await supabase
    .from("pickup_event")
    .select(FIRE_COLUMNS)
    .eq("rule_id", candidate.rule.id)
    .eq("stay_date", candidate.stay_date)
    .eq("affected_room_type_id", candidate.affected_room_type_id)
    .eq("fire_seq", candidate.fire_seq)
    .maybeSingle();
  return row ? { status: "inserted", effect: pickupEffectOf(row) } : { status: "write_failed" };
}

export type PickupWin = { candidate: PickupCandidate; effect: PickupEffect };

export type PickupPassOutcome = {
  winners: PickupWin[];
  /** Outranked by the rule that fired, or by one whose write failed or was recorded by another run. */
  losers: PickupCandidate[];
  /** Outranked by a rule still waiting on the cell: nothing fired there. */
  held: { candidate: PickupCandidate; holder: PickupCandidate }[];
  /** The waiting rules that held a cell. */
  holding: PickupCandidate[];
  /** Another run recorded this fire first. Not a winner, and not written by this run. */
  concurrent_skips: PickupCandidate[];
  /** A rule genuinely fired and lost its price effect to a write error. */
  write_failures: PickupCandidate[];
};

/**
 * Run the full pickup pass: group by (hotel, stay_date, affected_room_type),
 * compete, insert winners. `holders` are rules waiting on a cell whose
 * conditions still match; they compete but never write, and a cell one of
 * them wins gets no fire. A cell with only holders is left alone.
 */
export async function runPickupPass(
  supabase: SupabaseClient,
  candidates: PickupCandidate[],
  hotelId: string,
  basePrices: Map<string, number>,
  holders: PickupCandidate[] = [],
): Promise<PickupPassOutcome> {
  const groups = new Map<string, PickupCandidate[]>();
  for (const c of candidates) {
    const key = `${hotelId}|${c.stay_date}|${c.affected_room_type_id}`;
    const group = groups.get(key) ?? [];
    group.push(c);
    groups.set(key, group);
  }
  const holdersByCell = new Map<string, PickupCandidate[]>();
  for (const h of holders) {
    const key = `${hotelId}|${h.stay_date}|${h.affected_room_type_id}`;
    const list = holdersByCell.get(key) ?? [];
    list.push(h);
    holdersByCell.set(key, list);
  }

  const outcome: PickupPassOutcome = {
    winners: [],
    losers: [],
    held: [],
    holding: [],
    concurrent_skips: [],
    write_failures: [],
  };

  for (const [key, group] of groups) {
    const waiting = holdersByCell.get(key) ?? [];
    const winner = selectPickupWinner([...group, ...waiting], basePrices);
    if (!winner) continue;

    if (waiting.includes(winner)) {
      outcome.holding.push(winner);
      for (const c of group) outcome.held.push({ candidate: c, holder: winner });
      continue;
    }

    const result = await insertPickupEvent(supabase, winner, hotelId);
    if (result.status === "inserted") outcome.winners.push({ candidate: winner, effect: result.effect });
    else if (result.status === "concurrent_fire") outcome.concurrent_skips.push(winner);
    else outcome.write_failures.push(winner);
    for (const c of group) {
      if (c !== winner) outcome.losers.push(c);
    }
  }

  return outcome;
}

/* ── Taking fires off ─────────────────────────────────────────── */

/** An open fire, with what the run needs to price it, heal it or test it for cancellations. */
export type OpenPickupFire = {
  id: string;
  rule_id: string;
  rule_version: number;
  stay_date: string;
  affected_room_type_id: string;
  applied_at: string;
  fire_seq: number;
  action_kind: string;
  action_direction: string;
  action_value: number;
  cancel_check: PickupCancelCheck;
  signal_booked_units_start: number;
  window_from: string | null;
  window_to: string | null;
  window_expected_at_fire: number | null;
  signal_set_key: string;
};

/**
 * Every open fire on the horizon's cells for the given room types, ordered
 * by cell and then applied_at and id: the order fires apply in. Paged.
 * Throws on a failed read: pricing without the fires would publish every
 * night without its adjustments.
 */
export async function loadOpenPickupFires(
  supabase: SupabaseClient,
  hotelId: string,
  roomTypeIds: string[],
  firstDate: string,
  lastDate: string,
): Promise<OpenPickupFire[]> {
  if (roomTypeIds.length === 0) return [];
  // deno-lint-ignore no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rows: any[];
  try {
    rows = await fetchAllRows(() =>
      supabase
        .from("pickup_event")
        .select(
          "id, rule_id, rule_version, stay_date, affected_room_type_id, applied_at, fire_seq, " +
            "action_kind, action_direction, action_value, cancel_check, signal_booked_units_start, " +
            "window_from, window_to, window_expected_at_fire, signal_set_key",
        )
        .eq("hotel_id", hotelId)
        .in("affected_room_type_id", roomTypeIds)
        .gte("stay_date", firstDate)
        .lte("stay_date", lastDate)
        .is("retired_at", null)
        .order("stay_date", { ascending: true })
        .order("affected_room_type_id", { ascending: true })
        .order("applied_at", { ascending: true })
        .order("id", { ascending: true }),
    );
  } catch (e) {
    throw new Error(`Failed to load pickup effects: ${e instanceof Error ? e.message : String(e)}`);
  }
  return rows.map((r) => ({
    id: String(r.id),
    rule_id: String(r.rule_id),
    rule_version: Number(r.rule_version),
    stay_date: String(r.stay_date),
    affected_room_type_id: String(r.affected_room_type_id),
    applied_at: String(r.applied_at),
    fire_seq: Number(r.fire_seq),
    action_kind: r.action_kind,
    action_direction: r.action_direction,
    action_value: Number(r.action_value),
    cancel_check: (r.cancel_check ?? "none") as PickupCancelCheck,
    signal_booked_units_start: Number(r.signal_booked_units_start ?? 0),
    window_from: r.window_from != null ? String(r.window_from).slice(0, 10) : null,
    window_to: r.window_to != null ? String(r.window_to).slice(0, 10) : null,
    window_expected_at_fire: r.window_expected_at_fire != null ? Number(r.window_expected_at_fire) : null,
    signal_set_key: String(r.signal_set_key ?? ""),
  }));
}

/** The open fires as effects per `stay_date|room_type_id`, leaving out `retired`. */
export function pickupEffectsFromFires(
  fires: OpenPickupFire[],
  retired: ReadonlySet<string> = new Set(),
): Map<string, PickupEffect[]> {
  const out = new Map<string, PickupEffect[]>();
  for (const f of fires) {
    if (retired.has(f.id)) continue;
    const key = `${f.stay_date}|${f.affected_room_type_id}`;
    const list = out.get(key) ?? [];
    list.push(pickupEffectOf(f));
    out.set(key, list);
  }
  return out;
}

export type PickupRetireReason = "manual_price" | "rule_edited" | "bookings_cancelled";

export type RetiredPickupFire = { fire: OpenPickupFire; reason: PickupRetireReason };

/**
 * Whether cancellations have taken a raise's bookings back off the night.
 *
 * net_units: booked room-nights over the rule's measured room types, from
 * this run's snapshot, are back to where the fire's window opened. The bar is
 * deliberately high: a cancellation or two out of a real surge is noise.
 * window_bookings: bookings still on the books from the fire's frozen window
 * are back to what a night like it usually gets in that window. either: any
 * test that can be made says so.
 *
 * Never for a cut, a fire with no test, a rule that measures other room
 * types than it did at the fire, or a night this run has no numbers for.
 */
export function cancellationCrossed(
  fire: OpenPickupFire,
  rule: EngineRule,
  bookedByCell: ReadonlyMap<string, number>,
  bsCtx: BookingSpeedContext | null,
): boolean {
  if (fire.action_direction !== "increase" || fire.cancel_check === "none") return false;
  if (rule.signal_room_type_ids.length === 0) return false;
  if (signalSetKey(rule.signal_room_type_ids) !== fire.signal_set_key) return false;

  if (fire.cancel_check === "net_units" || fire.cancel_check === "either") {
    let current = 0;
    let sawAnyCell = false;
    for (const rtId of rule.signal_room_type_ids) {
      const cell = bookedByCell.get(`${fire.stay_date}|${rtId}`);
      if (cell === undefined) continue;
      sawAnyCell = true;
      current += cell;
    }
    if (sawAnyCell && current <= fire.signal_booked_units_start) return true;
  }

  if (fire.cancel_check === "window_bookings" || fire.cancel_check === "either") {
    if (bsCtx && fire.window_from && fire.window_to && fire.window_expected_at_fire !== null) {
      const stillBooked = bookingsInFrozenWindow(
        bsCtx,
        fire.stay_date,
        fire.window_from,
        fire.window_to,
        rule.signal_room_type_ids,
      );
      if (stillBooked !== null && stillBooked <= fire.window_expected_at_fire) return true;
    }
  }
  return false;
}

/**
 * Which open fires this run takes off before anything fires, and why:
 *
 * - manual_price: fired before the open manual price on its cell was set. The
 *   price's save retires them itself; this catches a run that was already
 *   under way when the price was typed.
 * - rule_edited: fired by an older version of a rule this run loaded. The
 *   edit retires them itself; this catches an edit whose retirement failed or
 *   raced a run.
 * - bookings_cancelled: a raise whose bookings cancelled (cancellationCrossed),
 *   for a rule this run loaded. Paused rules are not loaded, so their fires
 *   stay as they are.
 *
 * A fire applied at or after `now` belongs to this run and is never taken off.
 */
export function firesToRetire(
  fires: OpenPickupFire[],
  input: {
    rules: ReadonlyMap<string, EngineRule>;
    manualSetAtByCell: ReadonlyMap<string, string>;
    bookedByCell: ReadonlyMap<string, number>;
    bsCtx: BookingSpeedContext | null;
    now: string;
  },
): Map<string, PickupRetireReason> {
  const out = new Map<string, PickupRetireReason>();
  const nowMs = Date.parse(input.now);
  for (const fire of fires) {
    const appliedMs = Date.parse(fire.applied_at);
    if (appliedMs >= nowMs) continue;
    const setAt = input.manualSetAtByCell.get(`${fire.stay_date}|${fire.affected_room_type_id}`);
    if (setAt !== undefined && appliedMs < Date.parse(setAt)) {
      out.set(fire.id, "manual_price");
      continue;
    }
    const rule = input.rules.get(fire.rule_id);
    if (!rule) continue;
    if (fire.rule_version < rule.version) {
      out.set(fire.id, "rule_edited");
      continue;
    }
    if (cancellationCrossed(fire, rule, input.bookedByCell, input.bsCtx)) out.set(fire.id, "bookings_cancelled");
  }
  return out;
}

const RETIRE_CHUNK = 200;

/**
 * Stamp retired_at and retired_reason on the given fires, still open, in
 * chunks per reason. Returns the ids actually retired: a chunk whose write
 * fails is logged and left open (and priced), for the next run to retry.
 */
export async function retireFires(
  supabase: SupabaseClient,
  hotelId: string,
  reasons: ReadonlyMap<string, PickupRetireReason>,
  now: string,
): Promise<Set<string>> {
  const retired = new Set<string>();
  const byReason = new Map<PickupRetireReason, string[]>();
  for (const [id, reason] of reasons) {
    const list = byReason.get(reason) ?? [];
    list.push(id);
    byReason.set(reason, list);
  }
  for (const [reason, ids] of byReason) {
    // Chunked: thousands of ids in one `in` filter overflow the request URL.
    for (let i = 0; i < ids.length; i += RETIRE_CHUNK) {
      const chunk = ids.slice(i, i + RETIRE_CHUNK);
      const { error } = await supabase
        .from("pickup_event")
        .update({ retired_at: now, retired_reason: reason })
        .eq("hotel_id", hotelId)
        .in("id", chunk)
        .is("retired_at", null);
      if (error) {
        console.error(
          JSON.stringify({ fn: "retireFires", step: "retire", hotelId, reason, ids: chunk.length, error: error.message }),
        );
        continue;
      }
      for (const id of chunk) retired.add(id);
    }
  }
  return retired;
}

/**
 * Take every open fire on a night before the hotel's date off, as
 * night_passed. Past nights are never priced, so this only keeps the ledger
 * honest. A failed write is logged; the next run tries again.
 */
export async function retirePassedNights(
  supabase: SupabaseClient,
  hotelId: string,
  localDate: string,
  now: string,
): Promise<void> {
  const { error } = await supabase
    .from("pickup_event")
    .update({ retired_at: now, retired_reason: "night_passed" })
    .eq("hotel_id", hotelId)
    .lt("stay_date", localDate)
    .is("retired_at", null);
  if (error) {
    console.error(JSON.stringify({ fn: "retirePassedNights", hotelId, error: error.message }));
  }
}
