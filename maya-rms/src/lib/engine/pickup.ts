/**
 * Event rules — Implementation Guide §7.3, §8, §11 steps 7-8.
 *
 * An event rule (is_pickup_rule: any rule with a pickup or Booking Speed
 * condition) fires once, and the fire keeps adjusting the night's price for
 * that room type until something takes it off. Fires stack: once a rule's
 * wait has passed on a night and room type and its condition still holds, it
 * fires again, so a raise raises again and a cut cuts again. Each fire is a
 * pickup_event row with its own fire number (fire_seq).
 *
 * WAIT (ruleWaitDays, waitAnchor, isWaiting). A Booking Speed rule waits its
 * cooldown (booking_speed_cooldown_days, a week when unset, never under a
 * day); a pickup count rule waits the wait its owner chose
 * (pickup_cooldown_days, never under a day), or its lookback window when
 * none was chosen (pickupWaitDays); a rule with both waits the longer. The
 * wait runs from the newest of: this rule version's latest fire on the cell
 * that is still open or came off for cancellations, a passed night or before
 * reasons were kept; and the set_at of an open manual price on the cell, for
 * a rule that existed when the price was set. Fires taken off by a manual
 * price or an edit never start a wait. Waits count whole hotel days (Jake,
 * 2026-09-28): a wait of N days from a change made on hotel day D ends when
 * hotel day D+N begins, whatever the hour of the change, so time alone never
 * ends one in the middle of a day.
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
 * fire counted from is the newest one still on the price (openFireHeads:
 * open once this run's own retirements are done), from its rule's current
 * version: a change that came off for cancellations covers nothing any
 * more, for the rule itself or for the rules below it, since the price no
 * longer carries it.
 *
 * A pickup condition counts net bookings over its window in whole hotel
 * days (baselineTsFrom; Jake, 2026-09-28): a count looking for more ("more
 * than" 0 or more) counts today so far and the pickup_window_days - 1 whole
 * days before it; a count looking for low pickup (pickupCountsCompleteDays)
 * counts the pickup_window_days complete days ending yesterday, and a
 * cancellation made today counts against it at once (countPickupToDayStart),
 * as booking speed cuts do. So the window never moves during a day. It
 * counts from that fire when that is later (pickupWindowOpensAt): then it
 * counts the room nights first seen after
 * the fire that are still booked (countPickupSinceChange), so a booking
 * from before the fire cancelling takes nothing from it. Counting starts
 * again only when a price actually changes (Jake, 2026-09-27): with a rule
 * for 10 bookings in a week (+20%) and one for 5 (+10%), 10 on Monday
 * raise the rule for 10; 3 more on Tuesday, one of Monday's cancelling on
 * Wednesday (the raise stays: its week still has 12) and 2 more on
 * Thursday raise the rule for 5 on Thursday, on the 3 + 2 since Monday's
 * raise. A wait its owner chose shorter
 * than the window is what lets its own fire open it later; left on the
 * window, only another rule's fire can. A stretch shorter than the window
 * is judged only when counting fewer bookings can't be what makes the
 * condition true, "more than" 0 or more (pickupJudgesShortStretch);
 * otherwise the rule has nothing to judge until a whole window has passed
 * since that fire, whatever its wait. A Booking Speed condition reads the
 * observation over its own window and needs no old snapshot. From that fire
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
 * WHICH RULE FIRES. At most one fire per cell per run: the strongest
 * candidate (selectPickupWinner), unless a stronger rule still waiting on
 * the cell holds it (runPickupPass), and then nothing fires there this run.
 * A waiting rule holds a rule that moves the price the same way only when
 * what it would count itself matches its condition again: the bookings
 * since the newest change on the cell by itself or a stronger rule, where
 * the weaker rule counts from too (Jake, 2026-09-24: 10 bookings at once
 * raise the rule for 10, and 5 more raise the rule for 5 on those 5 while
 * the rule for 10 waits). So the stronger rule keeps what would be its own
 * next raise or cut, and a weaker one still steps in on what is too little
 * for it. A waiting rule holds a rule that moves the price the other way
 * while its whole window still matches, as it always has: raises and cuts
 * never move each other's counts, so a raise that just fired isn't undone
 * the next run by a cut it outranked. A stronger rule can always fire
 * while a weaker one waits. A candidate is dropped before the competition
 * when it can't move the price in its own direction (limitAllowsFire), and
 * a cell the run leaves unpriced never gets a fire.
 *
 * WHEN A FIRE COMES OFF. Every fire comes off when its night passes, when a
 * manual price is set on the cell, and when the rule is edited.
 * Cancellations take one off only when its rule's box is ticked
 * (undo_on_cancellation, the default; Jake, 2026-09-25), the same way for a
 * raise or a cut and for every kind of rule, and then only when they make
 * the rule no longer true (cancellationsUndo). The check runs on the open
 * fires of a ticked rule on the nights ahead, never in the run that made
 * them, and only once a room booked on the night when the fire was made has
 * cancelled (the rows on the rule's room types first seen by then are fewer
 * than it saw). It recounts what the fire counted, not the night as it is
 * now: a booking speed condition counts the bookings in the fire's frozen
 * window that it saw and that are still booked, against the usual frozen at
 * the fire (window_expected_at_fire); a pickup condition counts its net
 * pickup over the fire's window, with the bookings that came in during it
 * and have cancelled since taken out; an occupancy condition reads the
 * night's sellable occupancy now. Bookings made after the fire never prop
 * it up. Only what cancellations can make false is judged
 * (cancellableParts): occupancy "more than", pickup "more than", a pace of
 * "at least" a level, or "exactly" one for a raise. A days-before-arrival
 * condition, anything "less than", and a pace of "at most" a level only get
 * truer as bookings cancel, so a cut is never undone because a night got
 * slower still. A fire whose own count falls short stays while its rule is
 * still true counted the way it would count without it, bookings made
 * since included (cancellablePartsHold, in evaluate.ts), and the numbers
 * the check recounts are taken again from that count at that run
 * (restateFire: checked_at and checked_count), so its window moving on
 * past the bookings it first counted never takes it off. Only the check
 * reads them: every rule still counts from the fire's own applied_at,
 * since the price did not change (openFireHeads). After an undo the rule's
 * wait runs on from the fire that came off (waitAnchor), so a night on the edge can't go up and down every
 * run, and once it is over the rule adjusts again if it is true again. The
 * fire no longer covers anything (openFireHeads) and no longer counts
 * toward the three-changes alert. Unticked, cancellations never take a fire
 * off. Pausing a rule changes nothing: its fires keep applying, still cover
 * the weaker rules, and are not checked while it is paused.
 *
 * SKIP. A rule switched on (or saved) with "Skip price adjustments" is held
 * on the days the popup showed (rule_skip_hold, one per day and room type,
 * belonging to the rule's skip_at; loadSkipHolds): there it makes no change,
 * and its changes on the price stay as they are (an edit does not take them
 * off, and cancellations are not checked on them), until it stops being
 * true there and then becomes true again (skipHoldStep). It is judged the
 * way Apply would judge it, counting from where it would count once its
 * changes from before an edit were off; the first time it is found true
 * after being found not true, the hold ends, those older changes come off,
 * and it acts there in that same run. A Skip never moves where any rule
 * counts from: a new rule counts the bookings made before it existed, as
 * it would with Apply. Changes it holds still cover the weaker rules that
 * move the price their way (ranked as they were made: rankedAsMade).
 */

import type { CancellationFinding, EngineRule, PickupCancelCheck } from "@/types/domain";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MIN_COMPARABLES_FULL_RANGE,
  bookingSpeedRank,
  classifyBookingSpeed,
  isBookingSpeed,
} from "@/lib/observations/booking-speed";
import {
  DEFAULT_BOOKING_SPEED_COOLDOWN_DAYS,
  bookingKeysOnNight,
  bookingsStillBookedFromFire,
  countsCompleteDays,
  isWithinCooldown,
  signalSetKey,
  windowBookingKeys,
  type BookingSpeedContext,
  type NightBookingRow,
  type SplitNeed,
} from "./booking-speed-provider";
import { conditionCount } from "./conditions";
import { pickupEffectOf, type PickupEffect } from "./pricing";
import {
  MIGRATIONS,
  bookedBeforeOver,
  fetchAllRows,
  filterNights,
  isMissingColumnError,
  isMissingRelationError,
  rangesForNights,
  type BookedBeforePair,
  type BookedCount,
  type NightSet,
} from "./snapshots";
import { addCalendarDays, evalIsoToHotelDateString, hotelDayStartIso } from "./timezone";
import type { PickupCandidate, RuleMetrics } from "./types";

export type { CancellationFinding };

const DAY_MS = 86_400_000;

/* ── Waits (§8) ───────────────────────────────────────────────── */

/**
 * Whole days an event rule waits after firing on a cell before it may fire
 * there again: the longer of its Booking Speed wait and its pickup wait
 * (pickupWaitDays). A stored cooldown under a day reads as a day: with
 * stacking, 0 would cut or raise every run.
 */
export function ruleWaitDays(rule: EngineRule): number {
  const c = rule.condition;
  const bookingSpeed = c.booking_speed_operator
    ? Math.max(1, c.booking_speed_cooldown_days ?? DEFAULT_BOOKING_SPEED_COOLDOWN_DAYS)
    : 0;
  const pickup = c.pickup_operator ? pickupWaitDays(c) : 0;
  const days = Math.max(bookingSpeed, pickup);
  return days > 0 ? days : DEFAULT_BOOKING_SPEED_COOLDOWN_DAYS;
}

/**
 * A pickup count condition's own wait: the one its owner chose
 * (pickup_cooldown_days), or its lookback window when none was chosen
 * (null), never under a day.
 */
export function pickupWaitDays(c: EngineRule["condition"]): number {
  return Math.max(1, c.pickup_cooldown_days ?? c.pickup_window_days ?? 3);
}

/**
 * Whether a pickup condition counts complete hotel days only, ending
 * yesterday (Jake, 2026-09-28): one that looks for low pickup ("fewer
 * than", or "more than" a number under zero), which a day not over yet
 * would read as low. One that looks for more counts today so far: a day
 * not over can only make it harder to reach (pickupJudgesShortStretch).
 */
export function pickupCountsCompleteDays(rule: Pick<RankedRule, "condition">): boolean {
  return !!rule.condition.pickup_operator && !pickupJudgesShortStretch(rule);
}

/**
 * Where a pickup condition's window opens, in whole hotel days, for a run on
 * hotel day `localDate`: the start of the day pickup_window_days - 1 days
 * back for a count that looks for more (today so far is its last day), and
 * of the day pickup_window_days back for one that counts complete days
 * (pickupCountsCompleteDays: yesterday is its last day). It moves only at
 * the hotel's midnight. null for a rule with no pickup condition, which
 * reads no old snapshot at all.
 */
export function baselineTsFrom(
  rule: Pick<RankedRule, "condition">,
  localDate: string,
  hotelTimeZone: string,
): string | null {
  if (!rule.condition.pickup_operator) return null;
  const windowDays = Math.max(1, rule.condition.pickup_window_days ?? 3);
  const back = pickupCountsCompleteDays(rule) ? windowDays : windowDays - 1;
  return hotelDayStartIso(addCalendarDays(localDate, -back), hotelTimeZone);
}

/**
 * Where a pickup condition's count ends, for a run at `now` on hotel day
 * `localDate`: now, or for a count of complete days
 * (pickupCountsCompleteDays) the start of today. Null without a pickup
 * condition.
 */
export function pickupCountEndsAt(
  rule: Pick<RankedRule, "condition">,
  now: string,
  localDate: string,
  hotelTimeZone: string,
): string | null {
  if (!rule.condition.pickup_operator) return null;
  return pickupCountsCompleteDays(rule) ? hotelDayStartIso(localDate, hotelTimeZone) : now;
}

/**
 * A pickup count of complete days (pickupCountsCompleteDays) ends at the
 * start of today (`dayStart`, pickupCountEndsAt): its "now" side is the room
 * nights, and their revenue, on the rule's room types first seen before
 * today began and still booked (loadBookedBefore at `dayStart`). So a
 * booking made today waits for tomorrow's count, and a cancellation made
 * today of a booking made before it counts against the window at once
 * (Jake, 2026-09-28: everything reacts, as booking speed cuts do). Rewrites
 * the now side and net pickup of `metrics` (computeRuleMetrics, which read
 * them from this run's snapshot), records where the count ended
 * (pickup_counted_to), and returns true; false, leaving them as read, when
 * the baseline was not usable or `dayStart` was not read.
 */
export function countPickupToDayStart(
  metrics: RuleMetrics,
  rule: Pick<EngineRule, "condition" | "signal_room_type_ids">,
  stayDate: string,
  dayStart: string,
  booked: ReadonlyMap<string, ReadonlyMap<string, BookedCount>>,
): boolean {
  if (!rule.condition.pickup_operator || rule.signal_room_type_ids.length === 0) return false;
  if (metrics.pickup_block_reason) return false;
  const seen = bookedBeforeOver(booked, stayDate, dayStart, rule.signal_room_type_ids);
  if (!seen) return false;
  metrics.signal_booked_units_now = seen.units;
  metrics.signal_booked_revenue_now = seen.revenue;
  metrics.net_pickup_units = Math.round(seen.units - (metrics.signal_booked_units_baseline ?? 0));
  metrics.net_pickup_revenue = Math.round((seen.revenue - (metrics.signal_booked_revenue_baseline ?? 0)) * 100) / 100;
  metrics.pickup_counted_to = dayStart;
  return true;
}

/**
 * What ranks an event rule against another on a cell (comparePickupRules)
 * and reads its fire history. Enough of a paused rule to rank it
 * (loadPausedEventRules): it never fires or holds a night, but its fires
 * stay on the price and still cover the rules below it (countFromFireAt).
 */
export type RankedRule = Pick<
  EngineRule,
  | "id"
  | "version"
  | "priority"
  | "condition"
  | "action_type"
  | "action_direction"
  | "action_value"
  | "created_at"
  | "version_ranks"
>;

/**
 * A rule as it ranked when it made `fire` (comparePickupRules), for a
 * change of an earlier version still on the price: one the owner's Skip holds
 * on, or one of a rule edited while it was off. It ranks by its own amount,
 * direction and kind (pickup_event.action_*), and by the priority and
 * condition its version had (version_ranks, written by save_rule when the
 * edit moved the version on), so an edit saved with Skip never changes which
 * weaker rules it covers. Without a record of that version (an edit saved
 * before save_rule kept one), the rule's own priority and condition stand
 * in. A change of the current version ranks as the rule.
 */
export function rankedAsMade(
  rule: RankedRule,
  fire: Pick<OpenPickupFire, "rule_version" | "action_kind" | "action_direction" | "action_value">,
): RankedRule {
  if (fire.rule_version === rule.version) return rule;
  const was = rule.version_ranks?.[String(fire.rule_version)];
  return {
    ...rule,
    version: fire.rule_version,
    ...(was ? { priority: Number(was.priority), condition: { ...was.condition } } : {}),
    action_type: fire.action_kind as RankedRule["action_type"],
    action_direction: fire.action_direction as RankedRule["action_direction"],
    action_value: Number(fire.action_value),
  };
}

/**
 * pricing_rules.version_ranks as read, or null when it is missing or not
 * the shape save_rule writes (a change of such a version then ranks by its
 * own amount and the rule's current priority and condition).
 */
export function versionRanksOf(value: unknown): EngineRule["version_ranks"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: NonNullable<EngineRule["version_ranks"]> = {};
  for (const [version, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!/^\d+$/.test(version) || !raw || typeof raw !== "object") continue;
    const r = raw as { priority?: unknown; condition?: unknown };
    const c = (r.condition && typeof r.condition === "object" ? r.condition : {}) as Record<string, unknown>;
    if (!Number.isFinite(Number(r.priority))) continue;
    const action = raw as { action_type?: unknown; action_direction?: unknown; action_value?: unknown };
    out[version] = {
      priority: Number(r.priority),
      ...(action.action_type === "percent" || action.action_type === "fixed" ? { action_type: action.action_type } : {}),
      ...(action.action_direction === "increase" || action.action_direction === "decrease" ? { action_direction: action.action_direction } : {}),
      ...(action.action_value != null && Number.isFinite(Number(action.action_value)) ? { action_value: Number(action.action_value) } : {}),
      condition: {
        occupancy_operator: (c.occupancy_operator ?? null) as RankedRule["condition"]["occupancy_operator"],
        dta_operator: (c.dta_operator ?? null) as RankedRule["condition"]["dta_operator"],
        pickup_operator: (c.pickup_operator ?? null) as RankedRule["condition"]["pickup_operator"],
        pickup_threshold: c.pickup_threshold != null ? Number(c.pickup_threshold) : null,
        pickup_metric: (c.pickup_metric ?? null) as RankedRule["condition"]["pickup_metric"],
        booking_speed_operator: (c.booking_speed_operator ?? null) as RankedRule["condition"]["booking_speed_operator"],
        booking_speed_level: c.booking_speed_level != null ? String(c.booking_speed_level) : null,
      },
    };
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * One day and room type a rule is held on after the owner's Skip
 * (rule_skip_hold): whether the engine found the rule true there the last
 * time it judged it (null: not judged yet).
 */
export type SkipHold = { ruleId: string; stayDate: string; roomTypeId: string; wasTrue: boolean | null };

/**
 * What one judgment does to a hold: the first records whether the rule is
 * true; after that, not true is remembered, and true after not true ends
 * the hold (the rule acts there from this run on).
 */
export function skipHoldStep(wasTrue: boolean | null, isTrue: boolean): { wasTrue: boolean; release: boolean } {
  if (wasTrue === false && isTrue) return { wasTrue: true, release: true };
  return { wasTrue: wasTrue === null ? isTrue : wasTrue && isTrue, release: false };
}

/**
 * The holds of the given rules' current Skips on the run's nights, per
 * fireHeadKey. A hold of an older Skip (the owner applied, or skipped again,
 * since) is none. Nothing before 99_supabase_migration_rule_activation_v1.sql
 * (no rule was ever skipped). Throws on any other failure: without its holds
 * a skipped rule would change the prices the owner asked it to leave.
 */
export async function loadSkipHolds(
  supabase: SupabaseClient,
  rules: readonly Pick<EngineRule, "id" | "skip_at">[],
  firstDate: string,
  lastDate: string,
  nights?: NightSet,
): Promise<Map<string, SkipHold>> {
  const out = new Map<string, SkipHold>();
  const skipped = new Map(rules.filter((r) => r.skip_at).map((r) => [r.id, Date.parse(String(r.skip_at))]));
  if (skipped.size === 0) return out;
  let rows: Record<string, unknown>[];
  try {
    rows = await fetchAllRows(() =>
      filterNights(
        supabase
          .from("rule_skip_hold")
          .select("rule_id, stay_date, room_type_id, skip_at, was_true")
          .in("rule_id", [...skipped.keys()]),
        nights,
        firstDate,
        lastDate,
      )
        .order("rule_id", { ascending: true })
        .order("stay_date", { ascending: true })
        .order("room_type_id", { ascending: true }),
    );
  } catch (e) {
    if (isMissingRelationError(e)) return out;
    throw new Error(`Failed to load the rules' Skip holds: ${e instanceof Error ? e.message : String(e)}`);
  }
  for (const r of rows) {
    const ruleId = String(r.rule_id);
    if (Date.parse(String(r.skip_at)) !== skipped.get(ruleId)) continue;
    const stayDate = String(r.stay_date).slice(0, 10);
    const roomTypeId = String(r.room_type_id);
    out.set(fireHeadKey(ruleId, stayDate, roomTypeId), {
      ruleId,
      stayDate,
      roomTypeId,
      wasTrue: r.was_true == null ? null : Boolean(r.was_true),
    });
  }
  return out;
}

/**
 * Write what a run found on the holds: `judged` the ones whose was_true
 * moved, `ended` the ones that are over. Grouped per rule, room type and
 * answer, one write per group. Failures are returned, not thrown: a hold
 * left as it was is judged again next run.
 */
export async function writeSkipHolds(
  supabase: SupabaseClient,
  judged: readonly SkipHold[],
  ended: readonly SkipHold[],
): Promise<string[]> {
  const failed: string[] = [];
  const groups = new Map<string, { hold: SkipHold; dates: string[]; end: boolean }>();
  for (const [list, end] of [[judged, false], [ended, true]] as const) {
    for (const h of list) {
      const key = `${end}|${h.ruleId}|${h.roomTypeId}|${h.wasTrue}`;
      const g = groups.get(key) ?? { hold: h, dates: [], end };
      g.dates.push(h.stayDate);
      groups.set(key, g);
    }
  }
  for (const { hold, dates, end } of groups.values()) {
    for (let i = 0; i < dates.length; i += 200) {
      const chunk = dates.slice(i, i + 200);
      const base = end
        ? supabase.from("rule_skip_hold").delete()
        : supabase.from("rule_skip_hold").update({ was_true: hold.wasTrue });
      const { error } = await base.eq("rule_id", hold.ruleId).eq("room_type_id", hold.roomTypeId).in("stay_date", chunk);
      if (error) failed.push(...chunk);
    }
  }
  return failed;
}

/** A cell's fire history for one rule, from pickup_fire_heads. */
export type FireHead = {
  /** Highest fire_seq of any version: the next fire is one above it. */
  maxFireSeq: number;
  /** This rule version's newest fire that starts a wait, or null. */
  anchorAt: string | null;
  /**
   * This rule version's fires still on the price. pickup_fire_heads reads
   * them before this run takes any off (and, before
   * 99_supabase_migration_undo_on_cancellation_v1.sql, counted the ones
   * taken off for cancellations too); the engine replaces both this and
   * lastCountedAt with the fires still open once its own retirements are
   * done (openFireHeads), which is what the three-changes alert counts and
   * where a rule counts from.
   */
  counted: number;
  /**
   * The newest applied_at of those: where the rules count from
   * (countFromFireAt). A change kept on bookings made since after
   * cancellations still counts from when it was made.
   */
  lastCountedAt: string | null;
  /**
   * The rule's changes still on the night that can cover a weaker rule, the
   * newest of each way it ranked (rankedAsMade: the current version as the
   * rule, an earlier one as it was made). countFromFireAt reads these for
   * the other rules on a cell; lastCountedAt stands in when absent.
   */
  covers?: FireCover[];
};

/** One of a rule's changes on a cell, as it ranks for covering the weaker rules (FireHead.covers). */
export type FireCover = { at: string; rank: RankedRule };

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
  /** The run's nights when they are not every night in the range (rangesForNights). */
  nights?: NightSet,
): Promise<Map<string, FireHead>> {
  const out = new Map<string, FireHead>();
  if (rules.length === 0) return out;
  const versionOf = new Map(rules.map((r) => [r.id, r.version]));
  for (const [segFirst, segLast] of rangesForNights(nights, firstDate, lastDate)) {
    await readFireHeads(supabase, hotelId, rules, versionOf, segFirst, segLast, out);
  }
  return out;
}

async function readFireHeads(
  supabase: SupabaseClient,
  hotelId: string,
  rules: Pick<EngineRule, "id" | "version">[],
  versionOf: ReadonlyMap<string, number>,
  firstDate: string,
  lastDate: string,
  out: Map<string, FireHead>,
): Promise<void> {
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
 * paused stronger rule raised or cut on. Also any other paused rule in
 * `withFires` (rules with changes on the price): one edited from a booking
 * speed or pickup rule into a standard one keeps its earlier changes, which
 * still cover what they covered (rankedAsMade). Throws on a failed read, as
 * the active rules' load does: counting them again would move prices the
 * owner never asked for.
 */
export async function loadPausedEventRules(
  supabase: SupabaseClient,
  hotelId: string,
  withFires: ReadonlySet<string> = new Set(),
): Promise<RankedRule[]> {
  const read = (skip: boolean) =>
    supabase
      .from("pricing_rules")
      .select(
        `
      id, version, priority, action_type, action_direction, action_value, created_at, is_pickup_rule,${skip ? " version_ranks," : ""}
      rule_condition ( occupancy_operator, dta_operator, pickup_operator, pickup_threshold, pickup_metric, booking_speed_operator, booking_speed_level )
    `,
      )
      .eq("hotel_id", hotelId)
      .eq("is_active", false);
  let { data, error } = await read(true);
  // No version_ranks yet (99_supabase_migration_rule_activation_v1.sql): no
  // earlier version's ranking was kept.
  if (error && isMissingColumnError(error)) ({ data, error } = await read(false));
  if (error) throw new Error(`Failed to load paused rules: ${error.message}`);
  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  return rows.filter((r) => r.is_pickup_rule === true || withFires.has(String(r.id))).map((r) => {
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
      version_ranks: versionRanksOf(r.version_ranks),
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
 * (countFromFireAt: its own newest fire still on the night, or a newer one
 * by a stronger rule that adjusts the same way). A raise rule counts from that
 * fire's hotel day, and on that day only the bookings first seen after the
 * fire (observeBookingSpeed `split`, keyed by `since`), so what the fire
 * could have counted is left out and what came after it is not. A fire
 * made on such a count records the split (window_since) and its frozen
 * window is read back the same way; its window still ends on its own day,
 * read whole (bookingsInFrozenWindow). A cut rule reads complete days only
 * (countsCompleteDays), so it counts from the day after the cut's, and the
 * cut's own day is never split.
 *
 * Fires taken off by a manual price, an edit or cancellations are not on
 * the night any more, and a fire made before the open manual price on the
 * cell is ignored too:
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
 * The fire a rule counts from on a cell, as an ISO instant: the newest fire
 * still on the night (`heads`, openFireHeads: lastCountedAt, from its rule's
 * current version) of the rule itself or of a rule in `others` that adjusts
 * the same way and ranks ahead of it on the cell (comparePickupRules, on the
 * cell's base price). `others` may hold any event rules, paused ones
 * included; the rest are skipped. So a stronger rule's change starts a
 * weaker rule's count over, and a weaker rule's never moves a stronger
 * rule's: a rule for 10 bookings in a week still counts the 5 a rule for 5
 * raised on. A change that came off for cancellations is not on the night,
 * so it covers nothing. null when none of them has a fire there.
 */
export function countFromFireAt(
  rule: RankedRule,
  others: readonly RankedRule[],
  heads: ReadonlyMap<string, Pick<FireHead, "lastCountedAt" | "covers">>,
  stayDate: string,
  roomTypeId: string,
  basePrice: number,
): string | null {
  let at = heads.get(fireHeadKey(rule.id, stayDate, roomTypeId))?.lastCountedAt ?? null;
  for (const other of others) {
    if (other.id === rule.id) continue;
    const head = heads.get(fireHeadKey(other.id, stayDate, roomTypeId));
    if (!head) continue;
    // Each change ranks as it was made (rankedAsMade): a change of an
    // earlier version a Skip holds covers what it covered before the edit.
    const covers = head.covers ?? (head.lastCountedAt ? [{ at: head.lastCountedAt, rank: other }] : []);
    for (const cover of covers) {
      if (cover.rank.action_direction !== rule.action_direction) continue;
      if (at !== null && Date.parse(cover.at) <= Date.parse(at)) continue;
      if (comparePickupRules(cover.rank, rule, basePrice, basePrice) < 0) at = cover.at;
    }
  }
  return at === null ? null : new Date(Date.parse(at)).toISOString();
}

/**
 * Per `rule_id|stay_date|room_type_id` (fireHeadKey), the fires of each
 * given rule still on the night, leaving out `retired` (the fires this run
 * took off): how many of its current version (counted, what the
 * three-changes alert counts) and the newest applied_at among them all
 * (lastCountedAt: where every rule counts from, countFromFireAt). A change the cancellation check
 * kept on bookings made since still counts from when it was made: its
 * checked_at is the check's alone, and counting starts again only when a
 * price changes. A change that came off for cancellations is not among
 * them: the price no longer carries it, so it covers no bookings, for its
 * own rule or any other, and the owner is only asked about changes still
 * on the price.
 */
export function openFireHeads(
  rules: readonly RankedRule[],
  openFires: readonly OpenPickupFire[],
  retired: ReadonlySet<string>,
): Map<string, Pick<FireHead, "lastCountedAt" | "counted" | "covers">> {
  const ruleOf = new Map(rules.map((r) => [r.id, r]));
  const out = new Map<string, Pick<FireHead, "lastCountedAt" | "counted" | "covers">>();
  // Per cell and rule, the newest change of each way it ranks.
  const coverOf = new Map<string, FireCover>();
  for (const fire of openFires) {
    if (retired.has(fire.id)) continue;
    const rule = ruleOf.get(fire.rule_id);
    if (!rule) continue;
    // A change still on the price covers what it counted, whichever version
    // of its rule made it: one the owner's Skip holds (rule_skip_hold), or one
    // of a rule edited while it was off (its changes stay on, frozen, until
    // it is switched on). It covers as it ranked when it was made
    // (rankedAsMade). A running rule's older changes came off before this
    // (firesToReset). Only the current version's count toward the
    // three-changes alert.
    const current = rule.version === fire.rule_version;
    const key = fireHeadKey(fire.rule_id, fire.stay_date, fire.affected_room_type_id);
    let head = out.get(key);
    if (!head) {
      head = { lastCountedAt: fire.applied_at, counted: current ? 1 : 0, covers: [] };
      out.set(key, head);
    } else {
      if (current) head.counted += 1;
      if (!head.lastCountedAt || Date.parse(fire.applied_at) > Date.parse(head.lastCountedAt)) {
        head.lastCountedAt = fire.applied_at;
      }
    }
    const way = current ? "current" : `${fire.rule_version}|${fire.action_kind}|${fire.action_direction}|${Number(fire.action_value)}`;
    const cover = coverOf.get(`${key}|${way}`);
    if (!cover) {
      const made = { at: fire.applied_at, rank: current ? rule : rankedAsMade(rule, fire) };
      coverOf.set(`${key}|${way}`, made);
      head.covers!.push(made);
    } else if (Date.parse(fire.applied_at) > Date.parse(cover.at)) {
      cover.at = fire.applied_at;
    }
  }
  return out;
}

/**
 * Whether a pickup condition may be judged on a stretch shorter than its
 * window, from the fire it counts from (pickupWindowOpensAt): only "more
 * than" a number of 0 or more, which fewer bookings can only make harder
 * to reach. "Less than" (or "more than" a negative number) would read a
 * short stretch as slow, so such a rule has nothing to judge until a whole
 * window has passed since that fire: its window counts complete days
 * (pickupCountsCompleteDays), so that is once the window's first day is the
 * fire's own (pickupFireDayStart).
 */
export function pickupJudgesShortStretch(rule: Pick<RankedRule, "condition">): boolean {
  const c = rule.condition;
  return c.pickup_operator === "gt" && (c.pickup_threshold ?? 0) >= 0;
}

/**
 * Where a pickup condition's window opens on a cell: the start of its first
 * hotel day (`baselineTs`, baselineTsFrom), or the fire it counts from
 * (countFromFireAt over openFireHeads: its own newest fire still on the
 * night, or a newer one by a stronger rule that adjusts the same way) when
 * that is later, so a pickup rule doesn't count
 * again the bookings it or a stronger rule already adjusted the night for:
 * with a wait shorter than its window, its next decision would otherwise
 * read the same burst again. From a fire it counts the room nights first
 * seen after it that are still booked (countPickupSinceChange). A
 * fire made before the open manual price on the cell is ignored, as for a
 * Booking Speed rule. null for a rule with no pickup condition.
 */
export function pickupWindowOpensAt(
  baselineTs: string | null,
  fireAt: string | null,
  manualPrice: { set_at: string } | undefined,
  /**
   * For a count of complete days (pickupCountsCompleteDays): where the
   * fire's hotel day began (pickupFireDayStart). The fire's own count ended
   * there, so this one may start there: each whole day is judged once.
   */
  fireDayStart?: string | null,
): string | null {
  if (baselineTs === null || fireAt === null) return baselineTs;
  if (manualPrice && Date.parse(fireAt) < Date.parse(manualPrice.set_at)) return baselineTs;
  const opensAt = fireDayStart ?? fireAt;
  return Date.parse(opensAt) > Date.parse(baselineTs) ? opensAt : baselineTs;
}

/**
 * Where a count of complete days (pickupCountsCompleteDays) may start after
 * the change it counts from: the start of that change's hotel day. The
 * change counted complete days ending the day before its own, so the day it
 * was made has not been judged yet, and starting there judges every whole
 * day once, never twice (Jake, 2026-09-28: waits and windows in whole hotel
 * days). A low-pickup rule has nothing to judge until its whole window lies
 * past that point (pickupJudgesShortStretch), so a rule that cut on day D
 * with a window of N days judges again on day D + N at the earliest, however
 * short its wait. Extra bookings can only make a low-pickup condition
 * harder to meet, so a stronger rule's change made later on day D never
 * lets it count a burst twice. null for a count that looks for more, which
 * counts from the change's instant.
 */
export function pickupFireDayStart(
  rule: Pick<RankedRule, "condition">,
  fireAt: string | null,
  hotelTimeZone: string,
): string | null {
  if (!fireAt || !pickupCountsCompleteDays(rule)) return null;
  return hotelDayStartIso(evalIsoToHotelDateString(fireAt, hotelTimeZone), hotelTimeZone);
}

/**
 * A pickup count that opened at a change (pickupWindowOpensAt gave that
 * change's instant, `since`) counts the room nights, and their revenue, on
 * the rule's room types first seen after the change and still booked now:
 * booked now less what was first seen by then and is still booked
 * (loadBookedBefore at `since`). So a booking from before the change
 * cancelling takes nothing from it: the change it counts from, and that
 * change's own cancellation check, answer for those bookings, and counting
 * starts again only when a price changes (Jake, 2026-09-27: 3 on Tuesday
 * and 2 on Thursday are 5 since Monday's raise, one of Monday's cancelling
 * on Wednesday or not). Rewrites the baseline and net pickup of `metrics`
 * (computeRuleMetrics, which read them from the snapshot at `since`) and
 * returns true; false, leaving them as read, when `since` was not read.
 */
export function countPickupSinceChange(
  metrics: RuleMetrics,
  rule: Pick<EngineRule, "condition" | "signal_room_type_ids">,
  stayDate: string,
  since: string,
  booked: ReadonlyMap<string, ReadonlyMap<string, BookedCount>>,
): boolean {
  if (!rule.condition.pickup_operator || rule.signal_room_type_ids.length === 0) return false;
  const before = bookedBeforeOver(booked, stayDate, since, rule.signal_room_type_ids);
  if (!before) return false;
  metrics.signal_booked_units_baseline = before.units;
  metrics.signal_booked_revenue_baseline = before.revenue;
  metrics.net_pickup_units = Math.round((metrics.signal_booked_units_now ?? 0) - before.units);
  metrics.net_pickup_revenue = Math.round(((metrics.signal_booked_revenue_now ?? 0) - before.revenue) * 100) / 100;
  metrics.pickup_block_reason = null;
  return true;
}

/**
 * Still waiting: a wait of `waitDays` from a change on hotel day D (the
 * anchor's date at the property) ends when hotel day D + waitDays begins
 * (Jake, 2026-09-28), so a run on `localDate` waits while its date is
 * before that. Time alone never ends a wait in the middle of a day.
 */
export function isWaiting(anchor: string | null, localDate: string, waitDays: number, hotelTimeZone: string): boolean {
  return isWithinCooldown(anchor, localDate, waitDays, hotelTimeZone);
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
    count_to: m.pickup_counted_to ?? now,
    signal_booked_units_start: measuresWindow ? (m.signal_booked_units_baseline ?? 0) : (m.signal_booked_units_now ?? 0),
    signal_booked_units_end: m.signal_booked_units_now ?? 0,
    signal_booked_revenue_start: measuresWindow
      ? (m.signal_booked_revenue_baseline ?? 0)
      : (m.signal_booked_revenue_now ?? 0),
    signal_booked_revenue_end: m.signal_booked_revenue_now ?? 0,
    fire_seq: (input.head?.maxFireSeq ?? 0) + 1,
    cancel_check: "recount",
    // Filled in before the competition (pickupArrivals in evaluate.ts).
    pickup_units_arrived: null,
    pickup_revenue_arrived: null,
    window_from: bs && windowTo ? addCalendarDays(windowTo, -(bs.window_days - 1)) : null,
    window_since: bs?.counted_since ?? null,
    window_to: windowTo,
    window_bookings_at_fire: bs ? bs.recent : null,
    window_expected_at_fire: bs ? Math.round(bs.expected * 100) / 100 : null,
    // Filled in before the competition (recordWindowKeys in evaluate.ts).
    window_booking_keys: null,
    signal_set_key: signalSetKey(rule.signal_room_type_ids),
  };
}

/**
 * What a run reads to record, on each candidate with a pickup condition,
 * what came in during its count (PickupCandidate.pickup_units_arrived): the
 * night at the instant the count opened (baseline_ts) and where it ended
 * (count_to: the run's own instant, or the start of today for a count of
 * complete days), for loadBookedBefore. The same two reads the
 * cancellation check makes later at the fire's baseline_start_ts and
 * baseline_end_ts, so both sides count by when a booking was first seen.
 */
export function arrivalReads(candidates: readonly PickupCandidate[]): BookedBeforePair[] {
  return candidates
    .filter((c) => c.rule.condition.pickup_operator)
    .flatMap((c) => [
      { stayDate: c.stay_date, at: c.baseline_ts },
      { stayDate: c.stay_date, at: c.count_to },
    ]);
}

/**
 * Record on a candidate with a pickup condition the room nights (and
 * revenue) on its room types first seen after its count opened and by
 * where it ended (count_to), still booked now: what was first seen by then,
 * less what was first seen by the time the count opened. Left null when
 * either instant was not read.
 */
export function recordArrivals(
  candidate: PickupCandidate,
  booked: ReadonlyMap<string, ReadonlyMap<string, BookedCount>>,
): void {
  if (!candidate.rule.condition.pickup_operator) return;
  const signal = candidate.rule.signal_room_type_ids;
  const opened = bookedBeforeOver(booked, candidate.stay_date, candidate.baseline_ts, signal);
  const seen = bookedBeforeOver(booked, candidate.stay_date, candidate.count_to, signal);
  if (!opened || !seen) return;
  candidate.pickup_units_arrived = Math.max(0, seen.units - opened.units);
  candidate.pickup_revenue_arrived = Math.max(0, Math.round((seen.revenue - opened.revenue) * 100) / 100);
}

/** The nights whose bookings windowKeyReads needs read (loadNightBookingRows) for these candidates. */
export function windowKeyNights(candidates: readonly PickupCandidate[]): string[] {
  return [
    ...new Set(
      candidates
        .filter((c) => cancellableParts(c.rule).bookingSpeed && c.window_from && c.window_to && c.window_bookings_at_fire != null)
        .map((c) => c.stay_date),
    ),
  ];
}

/**
 * Record on a candidate whose booking speed condition cancellations can
 * make false the bookings its window counted, by key (windowBookingKeys),
 * from `rows` (loadNightBookingRows for its night). Kept only when they
 * come to exactly what the reading counted (window_bookings_at_fire): a
 * sync that landed between the two reads, or a history that still counts
 * rooms, leaves it null, and the check then recounts the window the way
 * a change from before the keys is recounted.
 */
export function recordWindowKeys(
  candidate: PickupCandidate,
  ctx: BookingSpeedContext,
  rows: ReadonlyMap<string, readonly NightBookingRow[]>,
): void {
  if (!cancellableParts(candidate.rule).bookingSpeed) return;
  const { window_from, window_to, window_bookings_at_fire } = candidate;
  const night = rows.get(candidate.stay_date);
  if (!night || !window_from || !window_to || window_bookings_at_fire == null) return;
  const keys = windowBookingKeys(
    ctx,
    night,
    candidate.stay_date,
    window_from,
    window_to,
    candidate.rule.signal_room_type_ids,
    candidate.window_since,
  );
  candidate.window_booking_keys = keys && keys.length === window_bookings_at_fire ? keys : null;
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

let loggedPreUndoInsert = false;

/** Test hook: forget that the pre-migration insert line was already logged. */
export function resetPickupInsertLogOnce(): void {
  loggedPreUndoInsert = false;
}

/**
 * A write refused because pickup_event predates
 * 99_supabase_migration_undo_on_cancellation_v1.sql: a column it adds is
 * missing, or a check still refuses cancel_check 'recount'.
 */
function isPreUndoSchemaError(error: { code?: string | null; message?: string | null }): boolean {
  if (isMissingColumnError(error)) return true;
  const message = String(error.message ?? "");
  return (
    error.code === "23514" &&
    (message.includes("pickup_event_cancel_check_chk") || message.includes("pickup_event_cancel_increase_chk"))
  );
}

export async function insertPickupEvent(
  supabase: SupabaseClient,
  candidate: PickupCandidate,
  hotelId: string,
): Promise<PickupInsertResult> {
  const row = {
    hotel_id: hotelId,
    rule_id: candidate.rule.id,
    rule_version: candidate.rule.version,
    stay_date: candidate.stay_date,
    affected_room_type_id: candidate.affected_room_type_id,
    baseline_start_ts: candidate.baseline_ts,
    // Where the count ended: the fire's instant, or the start of its day
    // for a count of complete days (read back as count_end_ts).
    baseline_end_ts: candidate.count_to,
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
    pickup_units_arrived_at_fire: candidate.pickup_units_arrived,
    pickup_revenue_arrived_at_fire: candidate.pickup_revenue_arrived,
    window_from: candidate.window_from,
    window_since: candidate.window_since,
    window_to: candidate.window_to,
    window_bookings_at_fire: candidate.window_bookings_at_fire,
    window_expected_at_fire: candidate.window_expected_at_fire,
    window_booking_keys: candidate.window_booking_keys,
    signal_set_key: candidate.signal_set_key,
  };
  let { data, error } = await supabase.from("pickup_event").insert(row).select(FIRE_COLUMNS).single();
  // Deploy order is not ours to choose. Against a pickup_event from before
  // the undo migration the fire is written the way it was before it
  // ('none', no arrivals), which the cancellation check reads as a fire from
  // before it: its booking speed window is left as it was.
  if (error && isPreUndoSchemaError(error)) {
    if (!loggedPreUndoInsert) {
      loggedPreUndoInsert = true;
      console.error(
        JSON.stringify({
          fn: "insertPickupEvent",
          hotelId,
          schema: "pre-migration",
          message: `pickup_event takes no cancel_check 'recount' or arrivals yet; fires are written as before. Run ${MIGRATIONS.undoOnCancellation}.`,
          migration: MIGRATIONS.undoOnCancellation,
          error: error.message,
        }),
      );
    }
    const legacy: Record<string, unknown> = { ...row, cancel_check: "none" };
    delete legacy.pickup_units_arrived_at_fire;
    delete legacy.pickup_revenue_arrived_at_fire;
    delete legacy.window_booking_keys;
    ({ data, error } = await supabase
      .from("pickup_event")
      .insert(legacy)
      .select(FIRE_COLUMNS)
      .single());
  }

  if (error) {
    if (error.code === "23505" && String(error.message ?? "").includes(FIRE_UNIQUE_INDEX)) {
      return { status: "concurrent_fire" };
    }
    return { status: "write_failed" };
  }
  if (data) return { status: "inserted", effect: pickupEffectOf(data) };
  // Written, but the row did not come back: read it by its fire number.
  const { data: written } = await supabase
    .from("pickup_event")
    .select(FIRE_COLUMNS)
    .eq("rule_id", candidate.rule.id)
    .eq("stay_date", candidate.stay_date)
    .eq("affected_room_type_id", candidate.affected_room_type_id)
    .eq("fire_seq", candidate.fire_seq)
    .maybeSingle();
  return written ? { status: "inserted", effect: pickupEffectOf(written) } : { status: "write_failed" };
}

export type PickupWin = { candidate: PickupCandidate; effect: PickupEffect };

/** The effect a fire would have, for a dry run that writes none (its id is made up). */
function dryFireEffect(c: PickupCandidate, n: number): PickupEffect {
  return pickupEffectOf({
    id: `dry-${n}`,
    rule_id: c.rule.id,
    applied_at: c.eval_ts,
    fire_seq: c.fire_seq,
    action_kind: c.rule.action_type,
    action_direction: c.rule.action_direction,
    action_value: c.rule.action_value,
  });
}

/**
 * A rule waiting on a cell whose condition still matches, measured one of
 * two ways. "same_way": from where it counts itself (countFromFireAt), so
 * it holds only the weaker rules that move the price its way, which count
 * from there too. "other_way": over its whole window, so it holds the rules
 * that move the price the other way. A rule can hold a cell both ways.
 */
export type WaitingHolder = { candidate: PickupCandidate; against: "same_way" | "other_way" };

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
 * conditions still match (WaitingHolder); they never write. The strongest
 * candidate on a cell fires unless a holder that ranks ahead of it holds it
 * (one measured "same_way" for a candidate moving the price its way,
 * "other_way" for one moving it the other way), and then the cell gets no
 * fire. A cell with only holders is left alone. Every cell is decided
 * first; `beforeInsert` then gets the winners about to be written, all at
 * once, to record on them what only a fire keeps (recordCounts in
 * evaluate.ts), so nothing is read for a candidate that loses or is held.
 */
export async function runPickupPass(
  supabase: SupabaseClient,
  candidates: PickupCandidate[],
  hotelId: string,
  basePrices: Map<string, number>,
  holders: WaitingHolder[] = [],
  beforeInsert?: (winners: PickupCandidate[]) => Promise<void>,
  /** A dry run: every winner fires as it would, and nothing is written. */
  dryRun = false,
): Promise<PickupPassOutcome> {
  const groups = new Map<string, PickupCandidate[]>();
  for (const c of candidates) {
    const key = `${hotelId}|${c.stay_date}|${c.affected_room_type_id}`;
    const group = groups.get(key) ?? [];
    group.push(c);
    groups.set(key, group);
  }
  const holdersByCell = new Map<string, WaitingHolder[]>();
  for (const h of holders) {
    const key = `${hotelId}|${h.candidate.stay_date}|${h.candidate.affected_room_type_id}`;
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

  const toInsert: { winner: PickupCandidate; group: PickupCandidate[] }[] = [];
  for (const [key, group] of groups) {
    const winner = selectPickupWinner(group, basePrices);
    if (!winner) continue;

    // The waiting rules that rank ahead of the winner and hold it: the
    // strongest of them is the one recorded as holding the cell.
    const base = basePrices.get(basePriceKey(winner.stay_date, winner.affected_room_type_id)) ?? 100;
    const holding = (holdersByCell.get(key) ?? [])
      .filter(
        (h) =>
          (h.against === "same_way") === (h.candidate.rule.action_direction === winner.rule.action_direction) &&
          comparePickupRules(h.candidate.rule, winner.rule, base, base) < 0,
      )
      .map((h) => h.candidate);
    const holder = selectPickupWinner(holding, basePrices);
    if (holder) {
      outcome.holding.push(holder);
      for (const c of group) outcome.held.push({ candidate: c, holder });
      continue;
    }
    toInsert.push({ winner, group });
  }

  if (beforeInsert && toInsert.length > 0) await beforeInsert(toInsert.map((t) => t.winner));
  let dryFires = 0;
  for (const { winner, group } of toInsert) {
    const result: PickupInsertResult = dryRun
      ? { status: "inserted", effect: dryFireEffect(winner, ++dryFires) }
      : await insertPickupEvent(supabase, winner, hotelId);
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

/**
 * An open fire, with what the run needs to price it, heal it or check it
 * for cancellations. The numbers from cancel_check on are the ones the
 * cancellation check recounts: the fire's own, or, once a run kept it on
 * bookings made since (restateFire), the ones that run took again
 * (pickup_event.checked_count), which leave the fire's own columns as they
 * were for everything else that reads them.
 */
export type OpenPickupFire = {
  id: string;
  rule_id: string;
  rule_version: number;
  stay_date: string;
  affected_room_type_id: string;
  /** When the fire was made: where the rules count from after it (openFireHeads). */
  applied_at: string;
  /**
   * The instant the numbers below were taken: applied_at, or the run that
   * kept the fire on bookings made since and took them again
   * (pickup_event.checked_at). Only the cancellation check reads it.
   */
  checked_at: string;
  fire_seq: number;
  action_kind: string;
  action_direction: string;
  action_value: number;
  cancel_check: PickupCancelCheck;
  /** Where the fire's pickup count opened (its window's start, or the fire it counted from). */
  baseline_start_ts: string;
  /**
   * Where that count ended and what signal_booked_units_end was read at:
   * checked_at, except for a pickup count of complete days, whose count
   * ended at the start of its day (pickupCountEndsAt, stored as
   * baseline_end_ts). What the cancellation check reads "booked at the
   * fire" at.
   */
  count_end_ts: string;
  signal_booked_units_start: number;
  /** Room nights booked on the measured room types at the fire. */
  signal_booked_units_end: number;
  signal_booked_revenue_start: number;
  signal_booked_revenue_end: number;
  /** See PickupCandidate.pickup_units_arrived. null on fires from before they were stored. */
  pickup_units_arrived_at_fire: number | null;
  pickup_revenue_arrived_at_fire: number | null;
  window_from: string | null;
  /** The fire window_from's day was split at, or null: see PickupCandidate.window_since. */
  window_since: string | null;
  window_to: string | null;
  window_bookings_at_fire: number | null;
  window_expected_at_fire: number | null;
  /** See PickupCandidate.window_booking_keys. null on fires without them. */
  window_booking_keys: string[] | null;
  signal_set_key: string;
};

const OPEN_FIRE_COLUMNS =
  "id, rule_id, rule_version, stay_date, affected_room_type_id, applied_at, fire_seq, " +
  "action_kind, action_direction, action_value, cancel_check, baseline_start_ts, baseline_end_ts, " +
  "signal_booked_units_start, signal_booked_units_end, signal_booked_revenue_start, signal_booked_revenue_end, " +
  "window_from, window_since, window_to, window_bookings_at_fire, window_expected_at_fire, signal_set_key";
/** The columns 99_supabase_migration_undo_on_cancellation_v1.sql adds. */
const UNDO_COLUMNS =
  "pickup_units_arrived_at_fire, pickup_revenue_arrived_at_fire, window_booking_keys, checked_at, checked_count";

/**
 * The numbers a run that kept a fire on bookings made since took again for
 * the cancellation check (pickup_event.checked_count, restateFire): the
 * same names as the fire's own columns.
 */
export type CheckedCount = {
  baseline_start_ts: string;
  /** Where the count ended (PickupCandidate.count_to); absent on counts stored before it was. */
  baseline_end_ts?: string;
  signal_booked_units_start: number;
  signal_booked_units_end: number;
  signal_booked_revenue_start: number;
  signal_booked_revenue_end: number;
  pickup_units_arrived_at_fire: number | null;
  pickup_revenue_arrived_at_fire: number | null;
  window_from: string | null;
  window_since: string | null;
  window_to: string | null;
  window_bookings_at_fire: number | null;
  window_expected_at_fire: number | null;
  window_booking_keys: string[] | null;
};

/** What restateFire stores in checked_count from the count that kept a fire. */
export function checkedCountOf(candidate: PickupCandidate): CheckedCount {
  return {
    baseline_start_ts: candidate.baseline_ts,
    baseline_end_ts: candidate.count_to,
    signal_booked_units_start: candidate.signal_booked_units_start,
    signal_booked_units_end: candidate.signal_booked_units_end,
    signal_booked_revenue_start: candidate.signal_booked_revenue_start,
    signal_booked_revenue_end: candidate.signal_booked_revenue_end,
    pickup_units_arrived_at_fire: candidate.pickup_units_arrived,
    pickup_revenue_arrived_at_fire: candidate.pickup_revenue_arrived,
    window_from: candidate.window_from,
    window_since: candidate.window_since,
    window_to: candidate.window_to,
    window_bookings_at_fire: candidate.window_bookings_at_fire,
    window_expected_at_fire: candidate.window_expected_at_fire,
    window_booking_keys: candidate.window_booking_keys,
  };
}

let loggedPreUndoRead = false;

/** Test hook: forget that the pre-migration read line was already logged. */
export function resetOpenFiresLogOnce(): void {
  loggedPreUndoRead = false;
}

/**
 * Every open fire on the horizon's cells for the given room types, ordered
 * by cell and then applied_at and id: the order fires apply in. Paged.
 * Throws on a failed read: pricing without the fires would publish every
 * night without its adjustments. A fire with a checked_count reads its
 * numbers from there (OpenPickupFire). Before
 * 99_supabase_migration_undo_on_cancellation_v1.sql the columns it adds are
 * missing: the fires are read without them, as fires from before it.
 */
export async function loadOpenPickupFires(
  supabase: SupabaseClient,
  hotelId: string,
  roomTypeIds: string[],
  firstDate: string,
  lastDate: string,
  /** The run's nights when they are not every night in the range (filterNights). */
  nights?: NightSet,
): Promise<OpenPickupFire[]> {
  if (roomTypeIds.length === 0) return [];
  const read = (columns: string) =>
    fetchAllRows(() =>
      filterNights(
        supabase
          .from("pickup_event")
          .select(columns)
          .eq("hotel_id", hotelId)
          .in("affected_room_type_id", roomTypeIds),
        nights,
        firstDate,
        lastDate,
      )
        .is("retired_at", null)
        .order("stay_date", { ascending: true })
        .order("affected_room_type_id", { ascending: true })
        .order("applied_at", { ascending: true })
        .order("id", { ascending: true }),
    );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rows: any[];
  try {
    try {
      rows = await read(`${OPEN_FIRE_COLUMNS}, ${UNDO_COLUMNS}`);
    } catch (e) {
      if (!isMissingColumnError(e)) throw e;
      if (!loggedPreUndoRead) {
        loggedPreUndoRead = true;
        console.error(
          JSON.stringify({
            fn: "loadOpenPickupFires",
            hotelId,
            schema: "pre-migration",
            message: `pickup_event has no arrivals or checked columns yet; every open fire reads as one from before them. Run ${MIGRATIONS.undoOnCancellation}.`,
            migration: MIGRATIONS.undoOnCancellation,
            error: e instanceof Error ? e.message : String(e),
          }),
        );
      }
      rows = await read(OPEN_FIRE_COLUMNS);
    }
  } catch (e) {
    throw new Error(`Failed to load pickup effects: ${e instanceof Error ? e.message : String(e)}`);
  }
  const num = (v: unknown) => (v != null ? Number(v) : null);
  return rows.map((r) => {
    // Kept on bookings made since: the check recounts what that run counted.
    const checked =
      r.checked_at != null && r.checked_count != null && typeof r.checked_count === "object" ? r.checked_count : null;
    const c = checked ?? r;
    return {
      id: String(r.id),
      rule_id: String(r.rule_id),
      rule_version: Number(r.rule_version),
      stay_date: String(r.stay_date),
      affected_room_type_id: String(r.affected_room_type_id),
      applied_at: String(r.applied_at),
      checked_at: String(checked ? r.checked_at : r.applied_at),
      count_end_ts: String(
        checked ? (c.baseline_end_ts ?? r.checked_at) : (r.baseline_end_ts ?? r.applied_at),
      ),
      fire_seq: Number(r.fire_seq),
      action_kind: r.action_kind,
      action_direction: r.action_direction,
      action_value: Number(r.action_value),
      cancel_check: (checked ? "recount" : (r.cancel_check ?? "none")) as PickupCancelCheck,
      baseline_start_ts: String(c.baseline_start_ts ?? r.applied_at),
      signal_booked_units_start: Number(c.signal_booked_units_start ?? 0),
      signal_booked_units_end: Number(c.signal_booked_units_end ?? 0),
      signal_booked_revenue_start: Number(c.signal_booked_revenue_start ?? 0),
      signal_booked_revenue_end: Number(c.signal_booked_revenue_end ?? 0),
      pickup_units_arrived_at_fire: num(c.pickup_units_arrived_at_fire),
      pickup_revenue_arrived_at_fire: num(c.pickup_revenue_arrived_at_fire),
      window_from: c.window_from != null ? String(c.window_from).slice(0, 10) : null,
      window_since: c.window_since != null ? String(c.window_since) : null,
      window_to: c.window_to != null ? String(c.window_to).slice(0, 10) : null,
      window_bookings_at_fire: num(c.window_bookings_at_fire),
      window_expected_at_fire: num(c.window_expected_at_fire),
      window_booking_keys: Array.isArray(c.window_booking_keys) ? c.window_booking_keys.map(String) : null,
      signal_set_key: String(r.signal_set_key ?? ""),
    };
  });
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

/** A fire this run took off, and for one taken off for cancellations what was found no longer true. */
export type RetiredPickupFire = { fire: OpenPickupFire; reason: PickupRetireReason; finding?: CancellationFinding };

/**
 * The open fires a typed price or an edit takes off, before anything else
 * is decided:
 *
 * - manual_price: fired before the open manual price on its cell was set.
 *   The price's save retires them itself; this catches a run that was
 *   already under way when the price was typed.
 * - rule_edited: fired by an older version of a rule this run loaded,
 *   unless the owner's Skip holds its day and room type (`held`, from
 *   loadSkipHolds). An edit saved with Apply is taken off here, by
 *   the first run that prices the night.
 *
 * A fire applied at or after `now` belongs to this run and is never taken
 * off. The cancellation check comes after (firesCancelled), on what is left.
 */
export function firesToReset(
  fires: OpenPickupFire[],
  input: {
    rules: ReadonlyMap<string, EngineRule>;
    manualSetAtByCell: ReadonlyMap<string, string>;
    now: string;
    /** fireHeadKeys the owner's Skip holds (loadSkipHolds). */
    held?: ReadonlySet<string>;
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
    // A change the owner's Skip holds stays through the edit.
    if (!rule || fire.rule_version >= rule.version) continue;
    if (input.held?.has(fireHeadKey(fire.rule_id, fire.stay_date, fire.affected_room_type_id))) continue;
    out.set(fire.id, "rule_edited");
  }
  return out;
}

/* ── Taking fires off for cancellations ───────────────────────── */

/**
 * Which of a rule's conditions cancellations can make false, so the
 * cancellation check judges them (cancellationsUndo). Cancellations only
 * take bookings away, so occupancy, net pickup and a booking speed count can
 * only go down: the check judges only the bars they must stay above.
 * Occupancy "more than", pickup "more than", a pace of "at least" a level,
 * and "exactly" a level for a raise (anything slower is no longer it). A
 * days-before-arrival condition, anything "less than", a pace of "at most" a
 * level, and "exactly" a level for a cut (a cut's reason is a slow night,
 * and slower still keeps it) only get truer as bookings cancel, so they stay
 * as they were at the fire.
 */
export function cancellableParts(rule: Pick<EngineRule, "condition" | "action_direction">): {
  occupancy: boolean;
  pickup: boolean;
  bookingSpeed: boolean;
} {
  const c = rule.condition;
  return {
    occupancy: c.occupancy_operator === "gt" && c.occupancy_threshold != null,
    pickup: c.pickup_operator === "gt" && c.pickup_threshold != null,
    bookingSpeed:
      isBookingSpeed(c.booking_speed_level) &&
      (c.booking_speed_operator === "at_least" ||
        (c.booking_speed_operator === "is" && rule.action_direction === "increase")),
  };
}

/**
 * The open fires the cancellation check looks at, with their rules: fires
 * made before this run by the current version of a rule this run loaded
 * whose box is ticked (undo_on_cancellation, true unless the rule says
 * false), still measuring the room types it measured at the fire, with a
 * condition cancellations can make false (cancellableParts). Paused rules
 * are not loaded, so their fires are never checked, and nor are the fires
 * on a day and room type the owner's Skip holds (`held`, fireHeadKeys from
 * loadSkipHolds). `fires` are the ones firesToReset left.
 */
export function cancellationChecks(
  fires: readonly OpenPickupFire[],
  rules: ReadonlyMap<string, EngineRule>,
  now: string,
  held?: ReadonlySet<string>,
): { fire: OpenPickupFire; rule: EngineRule }[] {
  const out: { fire: OpenPickupFire; rule: EngineRule }[] = [];
  const nowMs = Date.parse(now);
  for (const fire of fires) {
    if (Date.parse(fire.applied_at) >= nowMs) continue;
    const rule = rules.get(fire.rule_id);
    if (!rule || fire.rule_version !== rule.version || rule.undo_on_cancellation === false) continue;
    // Held by the owner's Skip: left as it is.
    if (held?.has(fireHeadKey(fire.rule_id, fire.stay_date, fire.affected_room_type_id))) continue;
    if (rule.signal_room_type_ids.length === 0) continue;
    if (signalSetKey(rule.signal_room_type_ids) !== fire.signal_set_key) continue;
    const parts = cancellableParts(rule);
    if (!parts.occupancy && !parts.pickup && !parts.bookingSpeed) continue;
    out.push({ fire, rule });
  }
  return out;
}

/**
 * Whether a fire's booking speed window can be recounted: it has one, and
 * its numbers are in bookings (PickupCancelCheck: every fire since the undo
 * migration, and the older ones the old window test trusted).
 */
function windowRecountable(fire: OpenPickupFire): boolean {
  return (
    (fire.cancel_check === "recount" || fire.cancel_check === "window_bookings" || fire.cancel_check === "either") &&
    fire.window_from != null &&
    fire.window_to != null &&
    fire.window_bookings_at_fire != null &&
    fire.window_expected_at_fire != null
  );
}

/**
 * What the check reads first for these fires, all at once, for
 * loadBookedBefore: where each fire's count ended (count_end_ts: what was
 * booked then and is still booked) and, for a pickup condition, the instant
 * its count opened.
 * The rest is read only for the fires something they saw has cancelled on
 * (somethingCancelled, recountReads).
 */
export function cancellationReads(checks: readonly { fire: OpenPickupFire; rule: EngineRule }[]): BookedBeforePair[] {
  const booked: BookedBeforePair[] = [];
  for (const { fire, rule } of checks) {
    booked.push({ stayDate: fire.stay_date, at: fire.count_end_ts });
    if (cancellableParts(rule).pickup) booked.push({ stayDate: fire.stay_date, at: fire.baseline_start_ts });
  }
  return booked;
}

/**
 * Whether something a fire saw has cancelled: the room nights on its rule's
 * room types first seen by where its count ended (count_end_ts) and still
 * booked are fewer than it saw (signal_booked_units_end). Nothing else is
 * read or judged for a fire until then. false when this run did not read
 * the night.
 */
export function somethingCancelled(
  fire: OpenPickupFire,
  rule: EngineRule,
  booked: ReadonlyMap<string, ReadonlyMap<string, BookedCount>>,
): boolean {
  const atFire = bookedBeforeOver(booked, fire.stay_date, fire.count_end_ts, rule.signal_room_type_ids);
  return atFire !== null && atFire.units < fire.signal_booked_units_end;
}

/**
 * What the recount of these fires (the ones somethingCancelled let through)
 * reads next, all at once: for a booking speed window recorded with its
 * bookings' keys, the night's bookings now (loadNightBookingRows); for one
 * recorded without them, its bookings first seen after the fire's
 * checked_at, and after window_since when its first day was split
 * (loadSplitWindows).
 */
export function recountReads(checks: readonly { fire: OpenPickupFire; rule: EngineRule }[]): {
  nights: string[];
  splits: SplitNeed[];
} {
  const nights = new Set<string>();
  const splits: SplitNeed[] = [];
  for (const { fire, rule } of checks) {
    if (!cancellableParts(rule).bookingSpeed || !windowRecountable(fire)) continue;
    if (fire.window_booking_keys) {
      nights.add(fire.stay_date);
      continue;
    }
    splits.push({ since: fire.checked_at, stayDate: fire.stay_date, signalIds: rule.signal_room_type_ids });
    if (fire.window_since) {
      splits.push({ since: fire.window_since, stayDate: fire.stay_date, signalIds: rule.signal_room_type_ids });
    }
  }
  return { nights: [...nights].sort(), splits };
}

/** What this run knows about the nights it checks for cancellations. */
export type CancellationInput = {
  /** loadBookedBefore for cancellationReads(...). */
  booked: ReadonlyMap<string, ReadonlyMap<string, BookedCount>>;
  /** The night's sellable occupancy now over those room types, from this run's snapshot; null with nothing to sell. */
  occupancyNow: (stayDate: string, roomTypeIds: readonly string[]) => number | null;
  /** With recountReads(...).splits loaded (loadSplitWindows). */
  bsCtx: BookingSpeedContext | null;
  /** loadNightBookingRows for recountReads(...).nights. */
  nightRows?: ReadonlyMap<string, readonly NightBookingRow[]> | null;
};

/**
 * A fire's net pickup counted the way its rule counts it (room nights, or
 * revenue for a revenue rule) over the fire's own window, less the bookings
 * that came in during that window and have cancelled since: the net the
 * fire judged, less the room nights of its arrivals (first seen after its
 * count opened and by the fire, pickup_units_arrived_at_fire) that are no
 * longer booked, for a revenue rule each valued at the average rate its
 * arrivals had at the fire. So bookings made after the fire, older
 * bookings that cancel after it, and a rate changed on a booking still
 * there never move it, and with nothing of its own cancelled it is exactly
 * the number the fire judged. A fire from before the arrivals were stored
 * (null) counts what came in during its window and is still booked, which
 * leaves out the older bookings that cancelled inside the window before
 * the fire: never less than the right number, so it only keeps a change
 * on. null when this run could not read the night.
 */
function pickupStillCounted(
  fire: OpenPickupFire,
  rule: EngineRule,
  input: CancellationInput,
  atFire: BookedCount,
): number | null {
  const opened = bookedBeforeOver(input.booked, fire.stay_date, fire.baseline_start_ts, rule.signal_room_type_ids);
  if (!opened) return null;
  const revenue = rule.condition.pickup_metric === "revenue";
  const unitsArrived = fire.pickup_units_arrived_at_fire;
  const revenueArrived = fire.pickup_revenue_arrived_at_fire;
  if (unitsArrived == null || (revenue && revenueArrived == null)) {
    const arrivedNow = revenue ? atFire.revenue - opened.revenue : atFire.units - opened.units;
    return revenue ? Math.round(arrivedNow * 100) / 100 : Math.round(arrivedNow);
  }
  const lostUnits = Math.max(0, unitsArrived - (atFire.units - opened.units));
  if (!revenue) return Math.round(fire.signal_booked_units_end - fire.signal_booked_units_start - lostUnits);
  const averageRate = unitsArrived > 0 ? revenueArrived! / unitsArrived : 0;
  const net = fire.signal_booked_revenue_end - fire.signal_booked_revenue_start - lostUnits * averageRate;
  return Math.round(net * 100) / 100;
}

/**
 * The bookings a fire's booking speed window counted that are still
 * booked. With their keys recorded (window_booking_keys): those of them
 * with a row on the night now, on the rule's room types (bookingKeysOnNight
 * over input.nightRows), so a group is one of them until its last room
 * there cancels, whenever its rooms were added. Without: the window's
 * bookings still booked, less those first seen after the fire's checked_at
 * (bookingsStillBookedFromFire over the splits loaded). null when what it
 * needs was not read.
 */
function bookingsLeft(fire: OpenPickupFire, rule: EngineRule, input: CancellationInput): number | null {
  const ctx = input.bsCtx;
  if (!ctx) return null;
  const signal = rule.signal_room_type_ids;
  if (fire.window_booking_keys) {
    const night = input.nightRows?.get(fire.stay_date);
    if (!night) return null;
    const present = bookingKeysOnNight(ctx, night, signal);
    return fire.window_booking_keys.filter((key) => present.has(key)).length;
  }
  return bookingsStillBookedFromFire(
    ctx,
    fire.stay_date,
    fire.window_from!,
    fire.window_to!,
    signal,
    fire.window_since,
    fire.checked_at,
  );
}

/**
 * Whether a booking speed condition still holds on `recent` bookings against
 * the usual frozen at the fire, read the way the rule fired on it
 * (classifyBookingSpeed). How many comparable nights stood behind that usual
 * isn't stored, and with fewer than MIN_COMPARABLES_FULL_RANGE the reading
 * stops one step from Normal, so both are tried and either one keeps it
 * true: exact for "at least" a pace (a capped reading falls short only
 * where the full one does), and in doubt it keeps a change on. Only the
 * parts cancellableParts judges come here, where the pace can only have
 * gone down since the fire, so it is compared as "at least".
 */
function paceStillHolds(condition: EngineRule["condition"], recent: number, expected: number): boolean {
  if (!isBookingSpeed(condition.booking_speed_level)) return true;
  const target = bookingSpeedRank(condition.booking_speed_level);
  return [MIN_COMPARABLES_FULL_RANGE, 1].some(
    (comparableCount) =>
      classifyBookingSpeed({ recentBookings: recent, expectedBookings: expected, comparableCount }).rank >= target,
  );
}

/**
 * Whether cancellations have made what a fire counted fall short of its
 * rule, and what was found: null while it still holds. `fire` and `rule`
 * come from cancellationChecks. This is the first half of the check; the
 * change comes off only if its rule is not true either counted the way it
 * would count once the change is off (cancellablePartsHold, in
 * evaluate.ts).
 *
 * First, something the fire saw must have cancelled (somethingCancelled).
 * Then each part cancellations can make false (cancellableParts) is
 * judged, and the first one that fails is the finding:
 *
 * - occupancy "more than": the night's sellable occupancy now;
 * - pickup "more than": the fire's net pickup with the cancelled bookings
 *   that came in during its window taken out (pickupStillCounted);
 * - a pace: the bookings it counted in its frozen window that are still
 *   booked (bookingsLeft), against the usual frozen at the fire
 *   (window_expected_at_fire, paceStillHolds).
 *
 * A part this run can't recount (a night it did not read, a fire from
 * before its numbers were in bookings) is left as it was at the fire. So
 * are the other parts: they only get truer as bookings cancel.
 */
export function cancellationFinding(
  fire: OpenPickupFire,
  rule: EngineRule,
  input: CancellationInput,
): CancellationFinding | null {
  const signal = rule.signal_room_type_ids;
  const atFire = bookedBeforeOver(input.booked, fire.stay_date, fire.count_end_ts, signal);
  if (!atFire || atFire.units >= fire.signal_booked_units_end) return null;
  const c = rule.condition;
  const parts = cancellableParts(rule);
  if (parts.occupancy) {
    const occupancy = input.occupancyNow(fire.stay_date, signal);
    if (occupancy !== null && !(occupancy > c.occupancy_threshold!)) {
      return { part: "occupancy", occupancy, threshold: c.occupancy_threshold! };
    }
  }
  if (parts.pickup) {
    const net = pickupStillCounted(fire, rule, input, atFire);
    if (net !== null && !(net > c.pickup_threshold!)) {
      return {
        part: "pickup",
        net,
        threshold: c.pickup_threshold!,
        metric: c.pickup_metric === "revenue" ? "revenue" : "room_nights",
      };
    }
  }
  if (parts.bookingSpeed && windowRecountable(fire)) {
    const left = bookingsLeft(fire, rule, input);
    if (left !== null && !paceStillHolds(c, left, fire.window_expected_at_fire!)) {
      return {
        part: "booking_speed",
        left,
        counted: fire.window_bookings_at_fire,
        expected: fire.window_expected_at_fire!,
        level: c.booking_speed_level!,
      };
    }
  }
  return null;
}

/** Whether cancellations have made what a fire counted fall short of its rule (cancellationFinding found something). */
export function cancellationsUndo(fire: OpenPickupFire, rule: EngineRule, input: CancellationInput): boolean {
  return cancellationFinding(fire, rule, input) !== null;
}

/**
 * The fires whose own count cancellations have taken short of their rule
 * this run, each with what was found (cancellationFinding): each check
 * cancellationChecks names that has a finding. `fires` are the ones
 * firesToReset left. Each still has to fail cancellablePartsHold counted
 * the way its rule would count without it before it comes off.
 */
export function firesCancelled(
  fires: readonly OpenPickupFire[],
  input: CancellationInput & { rules: ReadonlyMap<string, EngineRule>; now: string },
): Map<string, CancellationFinding> {
  const out = new Map<string, CancellationFinding>();
  for (const { fire, rule } of cancellationChecks(fires, input.rules, input.now)) {
    const finding = cancellationFinding(fire, rule, input);
    if (finding) out.set(fire.id, finding);
  }
  return out;
}

/**
 * Whether every part of a rule that cancellations can make false
 * (cancellableParts) holds on `metrics`: the second half of the check.
 * `metrics` is the rule counted the way it would count once the change
 * whose count fell short is off (the newest other change still on the
 * night by itself or a stronger rule its way, else its whole window), so
 * bookings made since the change count, as they would for its next one.
 * True keeps the change on: the rule is still true, and taking the change
 * off would only have it make the same change again. A pace of "exactly" a
 * level for a raise reads as "at least" here, as in the first half: more
 * bookings since never make cancellations the reason it is off. The other
 * parts only get truer as bookings cancel and are not read.
 */
export function cancellablePartsHold(rule: EngineRule, metrics: RuleMetrics): boolean {
  const c = rule.condition;
  const parts = cancellableParts(rule);
  if (parts.occupancy && !(metrics.occupancy != null && metrics.occupancy > c.occupancy_threshold!)) return false;
  if (parts.pickup) {
    if (metrics.pickup_block_reason) return false;
    const net = c.pickup_metric === "revenue" ? metrics.net_pickup_revenue : metrics.net_pickup_units;
    if (net == null || !(net > c.pickup_threshold!)) return false;
  }
  if (parts.bookingSpeed) {
    const bs = metrics.booking_speed;
    if (metrics.booking_speed_block_reason || !bs || !isBookingSpeed(c.booking_speed_level)) return false;
    if (bs.rank < bookingSpeedRank(c.booking_speed_level)) return false;
  }
  return true;
}

let loggedRestateFailure = false;

/** Test hook: forget that a failed restate was already logged. */
export function resetRestateLogOnce(): void {
  loggedRestateFailure = false;
}

/**
 * Keep a change whose own count cancellations took short but whose rule is
 * still true counted without it (cancellablePartsHold), and take the
 * numbers the cancellation check recounts again from that count
 * (`candidate`, candidateFor on it, with its arrivals and window keys
 * recorded): checked_count, taken at checked_at (the candidate's eval_ts).
 * A later check recounts those bookings, in that window, against that
 * usual, so the window moving on past the bookings the change first
 * counted never takes it off. Nothing else moves: its applied_at (where
 * every rule counts from, since the price did not change), its own numbers
 * (what the three-changes alert describes), fire number and adjustment
 * stay, and its wait still runs from when it was made. Returns whether the
 * row was written; a failed write is logged once a run and the change
 * simply stays as it was, for the next run to check again.
 */
export async function restateFire(
  supabase: SupabaseClient,
  hotelId: string,
  fireId: string,
  candidate: PickupCandidate,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("pickup_event")
    .update({ checked_at: candidate.eval_ts, checked_count: checkedCountOf(candidate) })
    .eq("hotel_id", hotelId)
    .eq("id", fireId)
    .is("retired_at", null)
    .select("id");
  if (error) {
    if (!loggedRestateFailure) {
      loggedRestateFailure = true;
      console.error(
        JSON.stringify({ fn: "restateFire", hotelId, fireId, error: error.message, migration: MIGRATIONS.undoOnCancellation }),
      );
    }
    return false;
  }
  return (data ?? []).length > 0;
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
