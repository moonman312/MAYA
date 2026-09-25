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
 * WHAT A RULE MEASURES. A rule counts only the bookings made after the
 * newest change on the night and room type by itself or by a rule that
 * adjusts the same way and ranks ahead of it (countFromFireAt; Jake,
 * 2026-09-24, option A). A weaker rule's change never moves where a
 * stronger rule counts from ("the clock doesn't reset, the count just
 * continues"). With a rule for 5 bookings in a week (+10%) and one for 10
 * (+20%): 5 and then 5 more raise twice, the second time on all 10; 10 at
 * once raise once, and the rule for 5 then counts only what comes after
 * that raise. The same holds for cuts: a stronger cut covers the weaker
 * cut rules. Raises and cuts never move each other. "Ranks ahead" is the
 * order selectPickupWinner picks in (comparePickupRules): the bigger change
 * to the price first, then at the same change the more demanding condition
 * (a faster Booking Speed level, a pickup count harder to meet), then
 * priority, more conditions and the older rule. A paused rule's
 * fires stay on the price, so they still cover the rules below it. The
 * fire counted from is the newest one that counts toward the owner alert
 * (open, or taken off for cancellations), from its rule's current version.
 *
 * A pickup condition counts net bookings over its window (now minus
 * pickup_window_days), or from that fire when it is later
 * (pickupWindowOpensAt). Its own wait is at least as long as its window, so
 * only another rule's fire can open it later. A stretch shorter than the
 * window is judged only when counting fewer bookings can't be what makes the
 * condition true, "more than" 0 or more (pickupJudgesShortStretch);
 * otherwise the rule has nothing to judge until a whole window has passed
 * since that fire. A Booking Speed condition reads the observation over its
 * own window and needs no old snapshot. From that fire
 * (bookingSpeedCountFrom) a raise rule counts from the hotel day of the fire
 * on, and on that day only the bookings first seen after the fire
 * (reservations.created_at against its applied_at, the split in
 * observeBookingSpeed), so a burst later on the day of a raise is not lost
 * with it. A cut rule reads complete hotel days only, its stretch ending
 * yesterday on the night and on the nights it is compared with alike
 * (countsCompleteDays), first decision or repeat: after a cut it counts the
 * complete days after the cut's day, and until one has passed it has
 * nothing to judge (since_last_fire). A rule with no such fire on the cell
 * judges its whole window, and so does one after a manual price: the fires
 * the price took off never count, and neither does one made before it. A
 * ladder rule's adjustment is not a fire and moves nothing: it holds while
 * its condition holds.
 *
 * WHICH RULE FIRES. At most one fire per cell per run. The competition
 * (selectPickupWinner) includes rules waiting on the cell whose conditions
 * still match over their full window, so a stronger rule holds the cell
 * through its wait on what it fired on: if one of those ranks first, nothing
 * fires there this run. A stronger rule can always fire while a weaker one
 * waits. A candidate is dropped before the competition when it can't move
 * the price in its own direction (limitAllowsFire), and a cell the run
 * leaves unpriced never gets a fire.
 *
 * WHEN A FIRE COMES OFF. Cuts never come off for cancellations. A raise comes
 * off when the bookings behind it cancel (cancellationCrossed): for a pickup
 * raise, net bookings are back to where its window opened; for a Booking
 * Speed raise, the bookings still on the books from its frozen window (the
 * days it counted, cut short by its own earlier raise or not) are back to
 * what a night like it usually gets over them. Each stacked raise is tested
 * on its own numbers, and never in the run that made it. Every fire also comes
 * off when its night passes, when a manual price is set on the cell, and
 * when the rule is edited. Pausing a rule changes nothing: its fires keep
 * applying, still cover the weaker rules, and are not tested while it is
 * paused.
 */

import type { EngineRule, PickupCancelCheck } from "./domain.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { bookingSpeedRank, isBookingSpeed } from "../observations/booking-speed.ts";
import {
  DEFAULT_BOOKING_SPEED_COOLDOWN_DAYS,
  bookingsInFrozenWindow,
  countsCompleteDays,
  isWithinCooldown,
  signalSetKey,
  type BookingSpeedContext,
} from "./booking-speed-provider.ts";
import { conditionCount } from "./conditions.ts";
import { pickupEffectOf, type PickupEffect } from "./pricing.ts";
import { MIGRATIONS, fetchAllRows } from "./snapshots.ts";
import { addCalendarDays, evalIsoToHotelDateString } from "./timezone.ts";
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

/**
 * What ranks an event rule against another on a cell (comparePickupRules)
 * and reads its fire history. Enough of a paused rule to rank it
 * (loadPausedEventRules): it never fires or holds a night, but its fires
 * stay on the price and still cover the rules below it (countFromFireAt).
 */
export type RankedRule = Pick<
  EngineRule,
  "id" | "version" | "priority" | "condition" | "action_type" | "action_direction" | "action_value" | "created_at"
>;

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
 * counts are the ones of each rule's current version. Paused rules may be
 * among them: only countFromFireAt reads theirs.
 *
 * Throws on any failure, a missing function included: with no fire history
 * every rule would look unfired and stack on every run.
 */
export async function loadPickupFireHeads(
  supabase: SupabaseClient,
  hotelId: string,
  rules: Pick<EngineRule, "id" | "version">[],
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

/**
 * Event rules the owner paused, with what ranking them reads. Pausing
 * leaves a rule's fires on the price (and a paused rule is never loaded to
 * run), so without these a weaker rule would count again the bookings a
 * paused stronger rule raised or cut on. Throws on a failed read, as the
 * active rules' load does: counting them again would move prices the owner
 * never asked for.
 */
export async function loadPausedEventRules(supabase: SupabaseClient, hotelId: string): Promise<RankedRule[]> {
  const { data, error } = await supabase
    .from("pricing_rules")
    .select(
      `
      id, version, priority, action_type, action_direction, action_value, created_at,
      rule_condition ( occupancy_operator, dta_operator, pickup_operator, pickup_threshold, pickup_metric, booking_speed_operator, booking_speed_level )
    `,
    )
    .eq("hotel_id", hotelId)
    .eq("is_active", false)
    .eq("is_pickup_rule", true);
  if (error) throw new Error(`Failed to load paused rules: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => {
    const raw = Array.isArray(r.rule_condition) ? r.rule_condition[0] : r.rule_condition;
    const rc = (raw ?? {}) as Record<string, unknown>;
    return {
      id: String(r.id),
      version: Number(r.version ?? 1),
      priority: Number(r.priority),
      action_type: r.action_type as RankedRule["action_type"],
      action_direction: r.action_direction as RankedRule["action_direction"],
      action_value: Number(r.action_value),
      created_at: String(r.created_at),
      condition: {
        occupancy_operator: (rc.occupancy_operator ?? null) as RankedRule["condition"]["occupancy_operator"],
        dta_operator: (rc.dta_operator ?? null) as RankedRule["condition"]["dta_operator"],
        pickup_operator: (rc.pickup_operator ?? null) as RankedRule["condition"]["pickup_operator"],
        pickup_threshold: rc.pickup_threshold != null ? Number(rc.pickup_threshold) : null,
        pickup_metric: (rc.pickup_metric ?? null) as RankedRule["condition"]["pickup_metric"],
        booking_speed_operator: (rc.booking_speed_operator ?? null) as RankedRule["condition"]["booking_speed_operator"],
        booking_speed_level: rc.booking_speed_level != null ? String(rc.booking_speed_level) : null,
      },
    };
  });
}

/** Where a Booking Speed rule starts counting on a cell, after the fire it counts from there. */
export type BookingSpeedCountFrom = {
  /**
   * The first booking date (hotel date) counted: the day of the fire for a
   * raise rule, the day after it for a cut rule (complete days only).
   */
  from: string;
  /** A raise's applied_at: on `from`, only bookings first seen after it count. null for a cut. */
  since: string | null;
};

/**
 * Where a Booking Speed rule starts counting on a cell, or null to count
 * its whole window. `lastFireAt` is the fire it counts from there
 * (countFromFireAt: its own newest counted fire, or a newer one by a
 * stronger rule that adjusts the same way). A raise rule counts from that
 * fire's hotel day, and on that day only the bookings first seen after the
 * fire (observeBookingSpeed `split`, keyed by `since`), so what the fire
 * could have counted is left out and what came after it is not. A fire
 * made on such a count records the split (window_since) and its frozen
 * window is read back the same way; its window still ends on its own day,
 * read whole (bookingsInFrozenWindow). A cut rule reads complete days only
 * (countsCompleteDays), so it counts from the day after the cut's, and the
 * cut's own day is never split.
 *
 * Fires taken off by a manual price or an edit are not counted fires, and a
 * counted fire made before the open manual price on the cell is ignored too:
 * after a typed price the rule waits its wait from set_at and then judges
 * its full window. null for a rule with no Booking Speed condition.
 */
export function bookingSpeedCountFrom(
  rule: EngineRule,
  lastFireAt: string | null | undefined,
  manualPrice: { set_at: string } | undefined,
  hotelTimeZone: string,
): BookingSpeedCountFrom | null {
  if (!rule.condition.booking_speed_operator) return null;
  if (!lastFireAt) return null;
  if (manualPrice && Date.parse(lastFireAt) < Date.parse(manualPrice.set_at)) return null;
  const day = evalIsoToHotelDateString(lastFireAt, hotelTimeZone);
  return countsCompleteDays(rule.action_direction)
    ? { from: addCalendarDays(day, 1), since: null }
    : { from: day, since: lastFireAt };
}

/**
 * The fire a rule counts from on a cell, as an ISO instant: the newest
 * counted fire there (FireHead.lastCountedAt: open, or taken off for
 * cancellations, from its rule's current version) of the rule itself or of
 * a rule in `others` that adjusts the same way and ranks ahead of it on the
 * cell (comparePickupRules, on the cell's base price). `others` may hold
 * any event rules, paused ones included; the rest are skipped. So a
 * stronger rule's change starts a weaker rule's count over, and a weaker
 * rule's never moves a stronger rule's: a rule for 10 bookings in a week
 * still counts the 5 a rule for 5 raised on. null when none of them has a
 * counted fire there.
 */
export function countFromFireAt(
  rule: RankedRule,
  others: readonly RankedRule[],
  heads: ReadonlyMap<string, FireHead>,
  stayDate: string,
  roomTypeId: string,
  basePrice: number,
): string | null {
  let at = heads.get(fireHeadKey(rule.id, stayDate, roomTypeId))?.lastCountedAt ?? null;
  for (const other of others) {
    if (other.id === rule.id || other.action_direction !== rule.action_direction) continue;
    const otherAt = heads.get(fireHeadKey(other.id, stayDate, roomTypeId))?.lastCountedAt ?? null;
    if (!otherAt || (at !== null && Date.parse(otherAt) <= Date.parse(at))) continue;
    if (comparePickupRules(other, rule, basePrice, basePrice) < 0) at = otherAt;
  }
  return at === null ? null : new Date(Date.parse(at)).toISOString();
}

/**
 * Whether a pickup condition may be judged on a stretch shorter than its
 * window, from the fire it counts from (pickupWindowOpensAt): only "more
 * than" a number of 0 or more, which fewer bookings can only make harder
 * to reach. "Less than" (or "more than" a negative number) would read a
 * short stretch as slow, so such a rule has nothing to judge until a whole
 * window has passed since that fire.
 */
export function pickupJudgesShortStretch(rule: RankedRule): boolean {
  const c = rule.condition;
  return c.pickup_operator === "gt" && (c.pickup_threshold ?? 0) >= 0;
}

/**
 * Where a pickup condition's window opens on a cell: now minus its window
 * (`baselineTs`, baselineTsFrom), or the fire it counts from
 * (countFromFireAt) when that is later, so a pickup rule doesn't count
 * again the bookings a stronger rule already adjusted the night for. That
 * run wrote a snapshot at the fire's own instant, so the net bookings read
 * from there are the ones after it. A fire made before the open manual
 * price on the cell is ignored, as for a Booking Speed rule. null for a
 * rule with no pickup condition.
 */
export function pickupWindowOpensAt(
  baselineTs: string | null,
  fireAt: string | null,
  manualPrice: { set_at: string } | undefined,
): string | null {
  if (baselineTs === null || fireAt === null) return baselineTs;
  if (manualPrice && Date.parse(fireAt) < Date.parse(manualPrice.set_at)) return baselineTs;
  return Date.parse(fireAt) > Date.parse(baselineTs) ? fireAt : baselineTs;
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
  // The days it counted end on this run's day, or yesterday for a cut rule.
  const windowTo = bs ? (bs.counted_through ?? input.localDate) : null;
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
    window_from: bs && windowTo ? addCalendarDays(windowTo, -(bs.window_days - 1)) : null,
    window_since: bs?.counted_since ?? null,
    window_to: windowTo,
    window_bookings_at_fire: bs ? bs.recent : null,
    window_expected_at_fire: bs ? Math.round(bs.expected * 100) / 100 : null,
    signal_set_key: signalSetKey(rule.signal_room_type_ids),
  };
}

/* ── Per-room competition (§7.3) ──────────────────────────────── */

export function basePriceKey(stayDate: string, roomTypeId: string): string {
  return `${stayDate}|${roomTypeId}`;
}

/**
 * How far a rule moves a price, in money, on a cell whose base price is
 * `basePrice`: a percent of it, or a fixed amount. Rounded to a hundredth of
 * a cent, so 7% of 100 and a fixed 7 tie.
 */
function normalizedAdjustment(rule: Pick<EngineRule, "action_type" | "action_value">, basePrice: number): number {
  const money = rule.action_type === "percent" ? (rule.action_value / 100) * basePrice : rule.action_value;
  return Math.round(Math.abs(money) * 10_000) / 10_000;
}

/**
 * How demanding a rule's Booking Speed condition is, in the direction it
 * moves the price: a raise on Surging above one on Much Faster, a cut on
 * Much Slower above one on Slower. 1 to 7 (4 for a level the engine doesn't
 * know), 0 without one.
 */
function speedBar(rule: RankedRule): number {
  const c = rule.condition;
  if (!c.booking_speed_operator) return 0;
  if (!isBookingSpeed(c.booking_speed_level)) return 4;
  return 4 + (rule.action_direction === "decrease" ? -1 : 1) * bookingSpeedRank(c.booking_speed_level);
}

/**
 * A pickup condition's kind (0 without one), then how demanding its
 * threshold is within that kind: a higher count for "more than", a lower
 * one for "less than". Thresholds only compare within one kind, operator
 * and metric alike: "more than 10" and "less than 2" aren't points on one
 * number line, and neither are room nights and revenue.
 */
function pickupBar(rule: RankedRule): [kind: number, bar: number] {
  const c = rule.condition;
  if (!c.pickup_operator) return [0, 0];
  const kind = (c.pickup_metric === "revenue" ? 0 : 2) + (c.pickup_operator === "gt" ? 2 : 1);
  const threshold = c.pickup_threshold ?? 0;
  return [kind, c.pickup_operator === "gt" ? threshold : -threshold];
}

/** When the rule was made, in milliseconds; 0 for a time that doesn't parse, so the key stays a number. */
function createdMs(rule: RankedRule): number {
  const ms = new Date(rule.created_at).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * What ranks one event rule against another on a cell, strongest first:
 *
 * 1. the bigger change to the price, in money on the cell's base price;
 * 2. at the same change, the more demanding condition: a faster Booking
 *    Speed level for a raise (a slower one for a cut), then a pickup count
 *    harder to meet (a higher "more than", a lower "less than")
 *    (a rule with a Booking Speed condition ahead of one without, and one
 *    kind of pickup condition ahead of another, only so the order is the
 *    same whatever order the rules come in);
 * 3. the higher priority (owners can't set it: every rule they make is 100,
 *    and the starter rules are 105 to 130, in their own order);
 * 4. more conditions;
 * 5. the older rule; 6. the lower id.
 *
 * Each rule gets one key, compared field by field, so the order is total
 * and transitive and never depends on the order the rules were read in.
 * The competition picks by it (selectPickupWinner), and it is what a
 * stronger rule means when a rule counts from a stronger rule's change
 * (countFromFireAt). A tier that needs more bookings and changes the price
 * more is stronger, whatever else it has: Jake's rule for 10 bookings in a
 * week (+20%) ranks ahead of his rule for 5 (+10%), with or without an
 * extra condition on either, and two tiers that change the price by the
 * same amount rank by how fast they need bookings, not by when they were
 * made.
 */
function strengthKey(rule: RankedRule, basePrice: number): number[] {
  return [
    normalizedAdjustment(rule, basePrice),
    speedBar(rule),
    ...pickupBar(rule),
    rule.priority,
    conditionCount(rule),
    -createdMs(rule),
  ];
}

/**
 * Which of two event rules ranks first on a cell (strengthKey): negative
 * when `a` does. `baseA` and `baseB` are the cells' base prices, for
 * comparing a percent against a fixed amount. The ranking countFromFireAt
 * calls stronger.
 */
export function comparePickupRules(a: RankedRule, b: RankedRule, baseA: number, baseB: number): number {
  const ka = strengthKey(a, baseA);
  const kb = strengthKey(b, baseB);
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return kb[i] - ka[i];
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The strongest candidate on a cell (comparePickupRules).
 */
export function selectPickupWinner(
  candidates: PickupCandidate[],
  basePrices: Map<string, number>,
): PickupCandidate | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const sorted = [...candidates].sort((a, b) =>
    comparePickupRules(
      a.rule,
      b.rule,
      basePrices.get(basePriceKey(a.stay_date, a.affected_room_type_id)) ?? 100,
      basePrices.get(basePriceKey(b.stay_date, b.affected_room_type_id)) ?? 100,
    ),
  );

  return sorted[0];
}

const PICKUP_KIND_WORDS = ["none", "revenue less than", "revenue more than", "room nights less than", "room nights more than"];

/**
 * §14 — deterministic tie-break explanation vs the winning candidate, step
 * by step in the order comparePickupRules ranks.
 */
export function pickupTieBreakTrace(winner: PickupCandidate, other: PickupCandidate, basePrices: Map<string, number>): string[] {
  const trace: string[] = [];
  const baseW = basePrices.get(basePriceKey(winner.stay_date, winner.affected_room_type_id)) ?? 100;
  const baseO = basePrices.get(basePriceKey(other.stay_date, other.affected_room_type_id)) ?? 100;
  const adjW = normalizedAdjustment(winner.rule, baseW);
  const adjO = normalizedAdjustment(other.rule, baseO);
  if (adjW !== adjO) {
    trace.push(`normalized_adjustment: ${adjW.toFixed(2)} beats ${adjO.toFixed(2)}`);
    return trace;
  }
  trace.push(`normalized_adjustment: tie`);

  const wSpeed = speedBar(winner.rule);
  const oSpeed = speedBar(other.rule);
  if (wSpeed !== oSpeed) {
    trace.push(
      wSpeed > 0 && oSpeed > 0
        ? `booking_speed: ${winner.rule.condition.booking_speed_level} beats ${other.rule.condition.booking_speed_level}`
        : `booking_speed: a booking speed condition ranks ahead of none`,
    );
    return trace;
  }
  trace.push(`booking_speed: tie`);

  const [wKind, wBar] = pickupBar(winner.rule);
  const [oKind, oBar] = pickupBar(other.rule);
  // Only claim a threshold win when both sides share the same operator and
  // metric. Different kinds aren't comparable, so the trace says so and
  // names the fixed order that decided.
  if (wKind !== oKind) {
    trace.push(`pickup_threshold: not comparable (different operators or metrics); ${PICKUP_KIND_WORDS[wKind]} ranks ahead of ${PICKUP_KIND_WORDS[oKind]}`);
    return trace;
  }
  if (wBar !== oBar) {
    const wTh = winner.rule.condition.pickup_threshold ?? 0;
    const oTh = other.rule.condition.pickup_threshold ?? 0;
    trace.push(
      winner.rule.condition.pickup_operator === "gt"
        ? `pickup_threshold(gt): ${wTh} beats ${oTh}`
        : `pickup_threshold(lt): stricter is lower; ${wTh} beats ${oTh}`,
    );
    return trace;
  }
  trace.push(`pickup_threshold: tie`);

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

  if (createdMs(winner.rule) !== createdMs(other.rule)) {
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
      window_since: candidate.window_since,
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
  /** The fire window_from's day was split at, or null: see PickupCandidate.window_since. */
  window_since: string | null;
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
            "window_from, window_since, window_to, window_expected_at_fire, signal_set_key",
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
    window_since: r.window_since != null ? String(r.window_since) : null,
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
 * (its first day split at the fire it counted from, when it was) are back to
 * what a night like it usually gets in that window. either: any test that
 * can be made says so.
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
        fire.window_since,
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
 * The engine runs the two halves apart (firesToReset, then firesCancelled
 * once the day splits the cancellation test needs are read); this is both
 * at once.
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
  const reset = firesToReset(fires, input);
  const cancelled = firesCancelled(fires.filter((f) => !reset.has(f.id)), input);
  const out = new Map<string, PickupRetireReason>();
  for (const f of fires) {
    const reason = reset.get(f.id) ?? cancelled.get(f.id);
    if (reason) out.set(f.id, reason);
  }
  return out;
}

/**
 * The open fires a typed price or an edit takes off (manual_price,
 * rule_edited; see firesToRetire). These stop counting for their rule
 * (pickup_fire_heads), so the engine takes them off before it reads the
 * fire history that says where each rule counts from. A fire taken off for
 * cancellations still counts, so that test can come after.
 */
export function firesToReset(
  fires: OpenPickupFire[],
  input: {
    rules: ReadonlyMap<string, EngineRule>;
    manualSetAtByCell: ReadonlyMap<string, string>;
    now: string;
  },
): Map<string, "manual_price" | "rule_edited"> {
  const out = new Map<string, "manual_price" | "rule_edited">();
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
    if (rule && fire.rule_version < rule.version) out.set(fire.id, "rule_edited");
  }
  return out;
}

/**
 * The open raises whose bookings cancelled (bookings_cancelled, see
 * cancellationCrossed), among `fires` (the ones firesToReset left). A raise
 * with window_since needs its day split read first (loadSplitWindows), or
 * its window test says nothing.
 */
export function firesCancelled(
  fires: OpenPickupFire[],
  input: {
    rules: ReadonlyMap<string, EngineRule>;
    bookedByCell: ReadonlyMap<string, number>;
    bsCtx: BookingSpeedContext | null;
    now: string;
  },
): Map<string, "bookings_cancelled"> {
  const out = new Map<string, "bookings_cancelled">();
  const nowMs = Date.parse(input.now);
  for (const fire of fires) {
    if (Date.parse(fire.applied_at) >= nowMs) continue;
    const rule = input.rules.get(fire.rule_id);
    if (!rule || fire.rule_version < rule.version) continue;
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
