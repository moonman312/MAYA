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
 * WAIT (ruleWaitDays, waitAnchor). A Booking Speed rule waits its cooldown
 * (booking_speed_cooldown_days, a week when unset, never under a day); a
 * pickup count rule waits the wait its owner chose (pickup_cooldown_days,
 * never under a day), or its lookback window when none was chosen
 * (pickupWaitDays); a rule with both waits the longer. The wait runs from
 * the newest of: this rule version's latest fire on the cell that is still
 * open or came off for cancellations, a passed night or before reasons were
 * kept; and the set_at of an open manual price on the cell, for a rule that
 * existed when the price was set. Fires taken off by a manual price or an
 * edit never start a wait.
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
 * A pickup condition counts net bookings over its window (now minus
 * pickup_window_days), or from that fire when it is later
 * (pickupWindowOpensAt): the run that made the fire wrote a snapshot at
 * that very instant, so the count starts from exactly what the fire saw.
 * A wait its owner chose shorter
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
 * slower still. After an undo the rule's wait runs on from the fire that
 * came off (waitAnchor), so a night on the edge can't go up and down every
 * run, and once it is over the rule adjusts again if it is true again. The
 * fire no longer covers anything (openFireHeads) and no longer counts
 * toward the three-changes alert. Unticked, cancellations never take a fire
 * off. Pausing a rule changes nothing: its fires keep applying, still cover
 * the weaker rules, and are not checked while it is paused.
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
  bookingsStillBookedFromFire,
  countsCompleteDays,
  isWithinCooldown,
  signalSetKey,
  type BookingSpeedContext,
  type SplitNeed,
} from "./booking-speed-provider";
import { conditionCount } from "./conditions";
import { pickupEffectOf, type PickupEffect } from "./pricing";
import {
  MIGRATIONS,
  bookedBeforeOver,
  fetchAllRows,
  isMissingColumnError,
  type BookedBeforePair,
  type BookedCount,
} from "./snapshots";
import { addCalendarDays, evalIsoToHotelDateString } from "./timezone";
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
  heads: ReadonlyMap<string, Pick<FireHead, "lastCountedAt">>,
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
 * Per `rule_id|stay_date|room_type_id` (fireHeadKey), the fires still on
 * the night from each given rule's current version, leaving out `retired`
 * (the fires this run took off): how many (counted, what the three-changes
 * alert counts) and the newest (lastCountedAt, where every rule counts from,
 * countFromFireAt). A change that came off for cancellations is not among
 * them: the price no longer carries it, so it covers no bookings, for its
 * own rule or any other, and the owner is only asked about changes still
 * on the price. Its run's snapshot also still holds the bookings that
 * cancelled, so a pickup count opened there would net every new booking
 * against them.
 */
export function openFireHeads(
  rules: readonly Pick<RankedRule, "id" | "version">[],
  openFires: readonly OpenPickupFire[],
  retired: ReadonlySet<string>,
): Map<string, Pick<FireHead, "lastCountedAt" | "counted">> {
  const versionOf = new Map(rules.map((r) => [r.id, r.version]));
  const out = new Map<string, Pick<FireHead, "lastCountedAt" | "counted">>();
  for (const fire of openFires) {
    if (retired.has(fire.id) || versionOf.get(fire.rule_id) !== fire.rule_version) continue;
    const key = fireHeadKey(fire.rule_id, fire.stay_date, fire.affected_room_type_id);
    const head = out.get(key);
    if (!head) {
      out.set(key, { lastCountedAt: fire.applied_at, counted: 1 });
      continue;
    }
    head.counted += 1;
    if (!head.lastCountedAt || Date.parse(fire.applied_at) > Date.parse(head.lastCountedAt)) {
      head.lastCountedAt = fire.applied_at;
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
 * window has passed since that fire.
 */
export function pickupJudgesShortStretch(rule: RankedRule): boolean {
  const c = rule.condition;
  return c.pickup_operator === "gt" && (c.pickup_threshold ?? 0) >= 0;
}

/**
 * Where a pickup condition's window opens on a cell: now minus its window
 * (`baselineTs`, baselineTsFrom), or the fire it counts from
 * (countFromFireAt over openFireHeads: its own newest fire still on the
 * night, or a newer one by a stronger rule that adjusts the same way) when
 * that is later, so a pickup rule doesn't count
 * again the bookings it or a stronger rule already adjusted the night for:
 * with a wait shorter than its window, its next decision would otherwise
 * read the same burst again. That run wrote a snapshot at the fire's own
 * instant, so the net bookings read from there are the ones after it. A
 * fire made before the open manual price on the cell is ignored, as for a
 * Booking Speed rule. null for a rule with no pickup condition.
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
    cancel_check: "recount",
    // Filled in before the competition (pickupArrivals in evaluate.ts).
    pickup_units_arrived: null,
    pickup_revenue_arrived: null,
    window_from: bs && windowTo ? addCalendarDays(windowTo, -(bs.window_days - 1)) : null,
    window_since: bs?.counted_since ?? null,
    window_to: windowTo,
    window_bookings_at_fire: bs ? bs.recent : null,
    window_expected_at_fire: bs ? Math.round(bs.expected * 100) / 100 : null,
    signal_set_key: signalSetKey(rule.signal_room_type_ids),
  };
}

/**
 * What a run reads to record, on each candidate with a pickup condition,
 * what came in during its count (PickupCandidate.pickup_units_arrived): the
 * night at the instant the count opened (baseline_ts) and at the run's own
 * instant (eval_ts), for loadBookedBefore. The same two reads the
 * cancellation check makes later at the fire's baseline_start_ts and
 * applied_at, so both sides count by when a booking was first seen.
 */
export function arrivalReads(candidates: readonly PickupCandidate[]): BookedBeforePair[] {
  return candidates
    .filter((c) => c.rule.condition.pickup_operator)
    .flatMap((c) => [
      { stayDate: c.stay_date, at: c.baseline_ts },
      { stayDate: c.stay_date, at: c.eval_ts },
    ]);
}

/**
 * Record on a candidate with a pickup condition the room nights (and
 * revenue) on its room types first seen after its count opened and by the
 * run's instant, still booked now: what was first seen by now, less what
 * was first seen by the time the count opened. Left null when either
 * instant was not read.
 */
export function recordArrivals(
  candidate: PickupCandidate,
  booked: ReadonlyMap<string, ReadonlyMap<string, BookedCount>>,
): void {
  if (!candidate.rule.condition.pickup_operator) return;
  const signal = candidate.rule.signal_room_type_ids;
  const opened = bookedBeforeOver(booked, candidate.stay_date, candidate.baseline_ts, signal);
  const seen = bookedBeforeOver(booked, candidate.stay_date, candidate.eval_ts, signal);
  if (!opened || !seen) return;
  candidate.pickup_units_arrived = Math.max(0, seen.units - opened.units);
  candidate.pickup_revenue_arrived = Math.max(0, Math.round((seen.revenue - opened.revenue) * 100) / 100);
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
    pickup_units_arrived_at_fire: candidate.pickup_units_arrived,
    pickup_revenue_arrived_at_fire: candidate.pickup_revenue_arrived,
    window_from: candidate.window_from,
    window_since: candidate.window_since,
    window_to: candidate.window_to,
    window_bookings_at_fire: candidate.window_bookings_at_fire,
    window_expected_at_fire: candidate.window_expected_at_fire,
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
 * fire. A cell with only holders is left alone.
 */
export async function runPickupPass(
  supabase: SupabaseClient,
  candidates: PickupCandidate[],
  hotelId: string,
  basePrices: Map<string, number>,
  holders: WaitingHolder[] = [],
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

/** An open fire, with what the run needs to price it, heal it or check it for cancellations. */
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
  /** Where the fire's pickup count opened (its window's start, or the fire it counted from). */
  baseline_start_ts: string;
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
  signal_set_key: string;
};

const OPEN_FIRE_COLUMNS =
  "id, rule_id, rule_version, stay_date, affected_room_type_id, applied_at, fire_seq, " +
  "action_kind, action_direction, action_value, cancel_check, baseline_start_ts, " +
  "signal_booked_units_start, signal_booked_units_end, signal_booked_revenue_start, signal_booked_revenue_end, " +
  "window_from, window_since, window_to, window_bookings_at_fire, window_expected_at_fire, signal_set_key";
const ARRIVAL_COLUMNS = "pickup_units_arrived_at_fire, pickup_revenue_arrived_at_fire";

let loggedPreUndoRead = false;

/** Test hook: forget that the pre-migration read line was already logged. */
export function resetOpenFiresLogOnce(): void {
  loggedPreUndoRead = false;
}

/**
 * Every open fire on the horizon's cells for the given room types, ordered
 * by cell and then applied_at and id: the order fires apply in. Paged.
 * Throws on a failed read: pricing without the fires would publish every
 * night without its adjustments. Before
 * 99_supabase_migration_undo_on_cancellation_v1.sql the arrivals columns are
 * missing: the fires are read without them, as fires from before it.
 */
export async function loadOpenPickupFires(
  supabase: SupabaseClient,
  hotelId: string,
  roomTypeIds: string[],
  firstDate: string,
  lastDate: string,
): Promise<OpenPickupFire[]> {
  if (roomTypeIds.length === 0) return [];
  const read = (columns: string) =>
    fetchAllRows(() =>
      supabase
        .from("pickup_event")
        .select(columns)
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rows: any[];
  try {
    try {
      rows = await read(`${OPEN_FIRE_COLUMNS}, ${ARRIVAL_COLUMNS}`);
    } catch (e) {
      if (!isMissingColumnError(e)) throw e;
      if (!loggedPreUndoRead) {
        loggedPreUndoRead = true;
        console.error(
          JSON.stringify({
            fn: "loadOpenPickupFires",
            hotelId,
            schema: "pre-migration",
            message: `pickup_event has no arrivals columns yet; every open fire reads as one from before them. Run ${MIGRATIONS.undoOnCancellation}.`,
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
    baseline_start_ts: String(r.baseline_start_ts ?? r.applied_at),
    signal_booked_units_start: Number(r.signal_booked_units_start ?? 0),
    signal_booked_units_end: Number(r.signal_booked_units_end ?? 0),
    signal_booked_revenue_start: Number(r.signal_booked_revenue_start ?? 0),
    signal_booked_revenue_end: Number(r.signal_booked_revenue_end ?? 0),
    pickup_units_arrived_at_fire: num(r.pickup_units_arrived_at_fire),
    pickup_revenue_arrived_at_fire: num(r.pickup_revenue_arrived_at_fire),
    window_from: r.window_from != null ? String(r.window_from).slice(0, 10) : null,
    window_since: r.window_since != null ? String(r.window_since) : null,
    window_to: r.window_to != null ? String(r.window_to).slice(0, 10) : null,
    window_bookings_at_fire: num(r.window_bookings_at_fire),
    window_expected_at_fire: num(r.window_expected_at_fire),
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

/** A fire this run took off, and for one taken off for cancellations what was found no longer true. */
export type RetiredPickupFire = { fire: OpenPickupFire; reason: PickupRetireReason; finding?: CancellationFinding };

/**
 * The open fires a typed price or an edit takes off, before anything else
 * is decided:
 *
 * - manual_price: fired before the open manual price on its cell was set.
 *   The price's save retires them itself; this catches a run that was
 *   already under way when the price was typed.
 * - rule_edited: fired by an older version of a rule this run loaded. The
 *   edit retires them itself; this catches an edit whose retirement failed
 *   or raced a run.
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
 * are not loaded, so their fires are never checked. `fires` are the ones
 * firesToReset left.
 */
export function cancellationChecks(
  fires: readonly OpenPickupFire[],
  rules: ReadonlyMap<string, EngineRule>,
  now: string,
): { fire: OpenPickupFire; rule: EngineRule }[] {
  const out: { fire: OpenPickupFire; rule: EngineRule }[] = [];
  const nowMs = Date.parse(now);
  for (const fire of fires) {
    if (Date.parse(fire.applied_at) >= nowMs) continue;
    const rule = rules.get(fire.rule_id);
    if (!rule || fire.rule_version !== rule.version || rule.undo_on_cancellation === false) continue;
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
 * What the check must read for these fires, all at once: for loadBookedBefore
 * each fire's own instant (what was booked then and is still booked) and,
 * for a pickup condition, the instant its count opened; for loadSplitWindows
 * each booking speed window's bookings first seen after the fire, and after
 * window_since when its first day was split.
 */
export function cancellationReads(checks: readonly { fire: OpenPickupFire; rule: EngineRule }[]): {
  booked: BookedBeforePair[];
  splits: SplitNeed[];
} {
  const booked: BookedBeforePair[] = [];
  const splits: SplitNeed[] = [];
  for (const { fire, rule } of checks) {
    const parts = cancellableParts(rule);
    booked.push({ stayDate: fire.stay_date, at: fire.applied_at });
    if (parts.pickup) booked.push({ stayDate: fire.stay_date, at: fire.baseline_start_ts });
    if (parts.bookingSpeed && windowRecountable(fire)) {
      splits.push({ since: fire.applied_at, stayDate: fire.stay_date, signalIds: rule.signal_room_type_ids });
      if (fire.window_since) {
        splits.push({ since: fire.window_since, stayDate: fire.stay_date, signalIds: rule.signal_room_type_ids });
      }
    }
  }
  return { booked, splits };
}

/** What this run knows about the nights it checks for cancellations. */
export type CancellationInput = {
  /** loadBookedBefore for cancellationReads(...).booked. */
  booked: ReadonlyMap<string, ReadonlyMap<string, BookedCount>>;
  /** The night's sellable occupancy now over those room types, from this run's snapshot; null with nothing to sell. */
  occupancyNow: (stayDate: string, roomTypeIds: readonly string[]) => number | null;
  /** With cancellationReads(...).splits loaded (loadSplitWindows). */
  bsCtx: BookingSpeedContext | null;
};

/**
 * A fire's net pickup counted the way its rule counts it (room nights, or
 * revenue for a revenue rule) over the fire's own window, less the bookings
 * that came in during that window and have cancelled since: the net the
 * fire judged, less how far its arrivals (first seen after its count opened
 * and by the fire, pickup_units_arrived_at_fire) have fallen since. So
 * bookings made after the fire, and older bookings that cancel after it,
 * never move it, and with nothing of its own cancelled it is exactly the
 * number the fire judged. A fire from before the arrivals were stored
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
  const arrivedNow = revenue ? atFire.revenue - opened.revenue : atFire.units - opened.units;
  const arrivedAtFire = revenue ? fire.pickup_revenue_arrived_at_fire : fire.pickup_units_arrived_at_fire;
  const netAtFire = revenue
    ? fire.signal_booked_revenue_end - fire.signal_booked_revenue_start
    : fire.signal_booked_units_end - fire.signal_booked_units_start;
  const net = arrivedAtFire == null ? arrivedNow : netAtFire - Math.max(0, arrivedAtFire - arrivedNow);
  return revenue ? Math.round(net * 100) / 100 : Math.round(net);
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
 * Whether cancellations have made a fire's rule no longer true, so the
 * change comes off (bookings_cancelled), and what was found false: null
 * while the rule still holds. `fire` and `rule` come from
 * cancellationChecks.
 *
 * First, something the fire saw must have cancelled: the room nights on the
 * rule's room types first seen by the fire and still booked are fewer than
 * the fire saw (signal_booked_units_end). Then each part cancellations can
 * make false (cancellableParts) is judged, and the first one that fails
 * takes the change off:
 *
 * - occupancy "more than": the night's sellable occupancy now;
 * - pickup "more than": the fire's net pickup with the cancelled bookings
 *   that came in during its window taken out (pickupStillCounted);
 * - a pace: the bookings in the fire's frozen window it saw and that are
 *   still booked (bookingsStillBookedFromFire), against the usual frozen at
 *   the fire (window_expected_at_fire, paceStillHolds).
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
  const atFire = bookedBeforeOver(input.booked, fire.stay_date, fire.applied_at, signal);
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
  if (parts.bookingSpeed && input.bsCtx && windowRecountable(fire)) {
    const left = bookingsStillBookedFromFire(
      input.bsCtx,
      fire.stay_date,
      fire.window_from!,
      fire.window_to!,
      signal,
      fire.window_since,
      fire.applied_at,
    );
    if (left !== null && !paceStillHolds(c, left, fire.window_expected_at_fire!)) {
      return {
        part: "booking_speed",
        left,
        counted: fire.window_bookings_at_fire,
        expected: fire.window_expected_at_fire!,
      };
    }
  }
  return null;
}

/** Whether cancellations have made a fire's rule no longer true (cancellationFinding found something). */
export function cancellationsUndo(fire: OpenPickupFire, rule: EngineRule, input: CancellationInput): boolean {
  return cancellationFinding(fire, rule, input) !== null;
}

/**
 * The fires cancellations take off this run (bookings_cancelled), each with
 * what was found no longer true: each check cancellationChecks names that
 * cancellationFinding says has gone false. `fires` are the ones
 * firesToReset left.
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
