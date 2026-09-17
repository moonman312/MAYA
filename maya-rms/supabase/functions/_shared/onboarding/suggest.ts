/**
 * Suggestion mode: what "Hold My Hand" becomes when the hotel already has
 * configuration someone owns.
 *
 * A re-run of the guided analysis must never overwrite existing rules or
 * guardrails — those encode a human's judgment, possibly tuned for reasons
 * the data can't see. Instead we compare what the data recommends against
 * what exists and emit per-item suggestions the user accepts or rejects.
 * Gaps get "add" suggestions; existing values only get "adjust" suggestions
 * when they drift far from what the history supports; values a human clearly
 * chose (non-default guardrails) are left alone entirely.
 */

import type { StarterRuleSpec } from "./generate-rules.ts";

export type ExistingRuleSummary = {
  id: string;
  name: string;
  is_active: boolean;
  is_pickup_rule: boolean;
  occupancy_operator: string | null;
  occupancy_threshold: number | null; // fraction
  pickup_operator: string | null;
  pickup_threshold: number | null;
  /** True when the rule carries a booking-speed condition. */
  has_booking_speed: boolean;
  start_date: string | null;
  end_date: string | null;
  is_annual: boolean;
  dow_mask: number;
  signal_room_type_ids: string[];
  affected_room_type_ids: string[];
};

export type RuleSuggestion =
  | {
      suggestion_type: "add_rule";
      spec: StarterRuleSpec;
      rationale: string;
    }
  | {
      suggestion_type: "adjust_rule";
      rule_id: string;
      rule_name: string;
      current_threshold: number; // occupancy fraction
      suggested_threshold: number;
      rationale: string;
    }
  | {
      suggestion_type: "remove_rule";
      rule_id: string;
      rule_name: string;
      rationale: string;
    };

/** How far (in occupancy points) an existing threshold may drift before we say something. */
const ADJUST_TOLERANCE_PTS = 10;

const monthDay = (ymd: string) => Number(ymd.slice(5, 7)) * 100 + Number(ymd.slice(8, 10));

/**
 * Whether a booking-speed rule's scope contains a pickup rule's, i.e.
 * whether removing the pickup rule leaves every date/room it was pricing
 * still covered. Booking speed counts bookings on the rule's own signal
 * room types, so the ladder has to watch at least what the pickup rule
 * watched, and the PRICE has to land in the same places: dates, days of
 * week, and affected room types. Every comparison errs toward "not
 * covered": a wrongly-suppressed removal suggestion costs nothing, a
 * wrongly-offered one deletes a rule the ladder never replaced.
 */
function coversScopeOf(bs: ExistingRuleSummary, r: ExistingRuleSummary): boolean {
  // A rule with no signal or no affected room types never fires (see
  // engine/scope.ts), so it can't cover anything no matter what its other
  // columns say.
  if (bs.signal_room_type_ids.length === 0) return false;
  if (bs.affected_room_type_ids.length === 0) return false;

  const bsSignal = new Set(bs.signal_room_type_ids);
  if (!r.signal_room_type_ids.every((id) => bsSignal.has(id))) return false;

  const bsAffected = new Set(bs.affected_room_type_ids);
  if (!r.affected_room_type_ids.every((id) => bsAffected.has(id))) return false;

  if ((r.dow_mask & ~bs.dow_mask & 127) !== 0) return false;

  // Date window. Unbounded covers everything; otherwise only like-shaped
  // windows are compared, and annual ones get the same month-day wrap
  // semantics the engine applies (engine/scope.ts annualWindowMatches).
  if (bs.start_date == null && bs.end_date == null) return true;
  if (bs.is_annual !== r.is_annual) return false;
  if (bs.is_annual) {
    if (!bs.start_date || !bs.end_date || !r.start_date || !r.end_date) return false;
    const bsS = monthDay(bs.start_date);
    const bsE = monthDay(bs.end_date);
    const rS = monthDay(r.start_date);
    const rE = monthDay(r.end_date);
    if (bsS <= bsE) {
      return rS <= rE && bsS <= rS && rE <= bsE;
    }
    // bs wraps the year end: r fits if it wraps inside it, or sits entirely
    // in either the tail-of-year or start-of-year segment.
    if (rS > rE) return bsS <= rS && rE <= bsE;
    return rS >= bsS || rE <= bsE;
  }
  const rStart = r.start_date ?? "";
  const rEnd = r.end_date ?? "9999-12-31";
  return (bs.start_date ?? "") <= rStart && rEnd <= (bs.end_date ?? "9999-12-31");
}

export function computeRuleSuggestions(
  existing: ExistingRuleSummary[],
  paceSpecs: StarterRuleSpec[],
  occupancyRef: { surgePct: number; peakPct: number } | null,
): RuleSuggestion[] {
  const out: RuleSuggestion[] = [];
  const active = existing.filter((r) => r.is_active);

  // The pace ladder is all-or-nothing: a hotel with ANY booking-speed rule
  // has a pace setup someone owns, and second-guessing their chosen levels
  // would be exactly the overreach suggestion mode exists to avoid. A hotel
  // with none gets the whole ladder offered, one accept/reject each. This
  // checks ALL rules, not just active ones — pausing the ladder (is_active
  // false) is a normal seasonal action, not an invitation to re-offer the
  // same five rules as fresh "add" suggestions and create active duplicates
  // of a set the owner will likely re-enable later. Same guard
  // generateStarterRules already uses.
  const hasBookingSpeedRule = existing.some((r) => r.has_booking_speed);
  if (!hasBookingSpeedRule) {
    for (const spec of paceSpecs) {
      const rationale =
        spec.action.action_direction === "decrease"
          ? "Nothing watches for dates falling behind their normal booking pace — slow nights sit at full price until it is too late to rescue them."
          : "Nothing watches for dates booking ahead of their normal pace — demand spikes pass by unpriced.";
      out.push({ suggestion_type: "add_rule", spec, rationale });
    }
  }

  // Raw-pickup rules conflict with the booking-speed ladder outright: both
  // react to the same demand signal, but pickup fires on a fixed count with
  // no idea what "normal" looks like for the date. Removal is only offered
  // when an ACTIVE booking-speed rule's scope actually contains the pickup
  // rule's — not when a ladder is merely proposed in a sibling add_rule
  // finding (each finding resolves independently, so the owner could accept
  // the removal and dismiss the adds), not when the ladder is paused, and
  // not when the pickup rule prices dates or room types the ladder never
  // touches (a Penthouse-only December rule is not "covered" by a ladder
  // scoped to standard rooms, or one generated before the Penthouse
  // existed).
  const paceRules = active.filter((r) => r.has_booking_speed);
  for (const r of active) {
    if (!r.is_pickup_rule || r.pickup_operator == null || r.has_booking_speed) continue;
    if (!paceRules.some((bs) => coversScopeOf(bs, r))) continue;
    out.push({
      suggestion_type: "remove_rule",
      rule_id: r.id,
      rule_name: r.name,
      rationale:
        `"${r.name}" reacts to a fixed booking count, which the booking-speed rules now cover ` +
        "with pace awareness. Keeping both would stack two price reactions on the same demand.",
    });
  }

  // Existing occupancy rules get a sanity check against the marks the
  // history actually supports. Adjust-only: new-rule suggestions are pace
  // rules now, so nothing here proposes fresh occupancy rules.
  if (occupancyRef) {
    const occupancyRules = active.filter(
      (r) => !r.is_pickup_rule && r.occupancy_operator === "gt" && r.occupancy_threshold != null,
    );
    for (const r of occupancyRules) {
      const currentPct = Math.round(r.occupancy_threshold! * 100);
      const nearestMark =
        Math.abs(currentPct - occupancyRef.surgePct) <= Math.abs(currentPct - occupancyRef.peakPct)
          ? occupancyRef.surgePct
          : occupancyRef.peakPct;
      if (Math.abs(currentPct - nearestMark) > ADJUST_TOLERANCE_PTS) {
        out.push({
          suggestion_type: "adjust_rule",
          rule_id: r.id,
          rule_name: r.name,
          current_threshold: r.occupancy_threshold!,
          suggested_threshold: nearestMark / 100,
          rationale:
            `"${r.name}" fires above ${currentPct}% occupancy, but your booking history ` +
            `suggests ${nearestMark}% is where nights actually become scarce.`,
        });
      }
    }
  }

  return out;
}

export type GuardrailState = {
  room_type_id: string;
  name: string;
  floor_price: number;
  ceiling_price: number;
  /** p99 nightly rate — outlier-resistant only once row_count clears
   *  MIN_ROWS_TO_TRUST_P99. Never use the raw max here: a single
   *  fat-fingered rate would become the basis of the ceiling. */
  observed_p99_rate: number | null;
  /** Median nightly rate — the anchor for a data-derived floor. */
  observed_median_rate: number | null;
  row_count: number;
};

export type GuardrailSuggestion = {
  suggestion_type: "set_guardrail";
  room_type_id: string;
  room_type_name: string;
  field: "floor_price" | "ceiling_price";
  current: number;
  suggested: number;
  rationale: string;
};

// Schema defaults meaning "never set": floor 1.00, ceiling 99999.99.
const FLOOR_UNSET_MAX = 1.0;
const CEILING_UNSET_MIN = 99_000;

/* ── Data-derived guardrails ─────────────────────────────────── */

/**
 * A floor well below normal discounting range still blocks a fat-fingered
 * $10 rate; 40% of the median is comfortably under any sane promotion.
 */
export const DATA_FLOOR_FRACTION_OF_MEDIAN = 0.4;
export const MIN_DATA_FLOOR = 10;
export const MIN_ROWS_FOR_DATA_GUARDRAILS = 30;
/**
 * percentile_cont interpolates: at n=30 the p99 rank sits 71% of the way to
 * the single highest row, so "p99 x 1.5, never the raw max" (the ceiling's
 * whole anti-surge premise) is false at the row counts MIN_ROWS_FOR_DATA_
 * GUARDRAILS alone admits — one fat-fingered rate can BE p99 there. This is
 * the row count past which a single outlier's interpolation weight is small
 * enough that p99 is actually a safe basis for a hard price cap. The floor
 * (median-based) has no such problem and keeps the lower bar.
 */
export const MIN_ROWS_TO_TRUST_P99 = 200;

/**
 * The floor a room type's own history supports, or null when there are too
 * few nights to call anything typical. The first import writes this and a
 * refresh only suggests it, so both go through here and never disagree.
 */
function dataFloorFor(rt: Pick<GuardrailState, "observed_median_rate" | "row_count">): number | null {
  if (rt.row_count < MIN_ROWS_FOR_DATA_GUARDRAILS) return null;
  if (!rt.observed_median_rate || rt.observed_median_rate <= 0) return null;
  return Math.max(
    MIN_DATA_FLOOR,
    Math.round((rt.observed_median_rate * DATA_FLOOR_FRACTION_OF_MEDIAN) / 5) * 5,
  );
}

/**
 * The ceiling a room type's own history supports: p99 x 1.5, never the raw
 * max, so one typo'd rate can't become the basis of the cap — which also
 * needs enough rows that the typo itself isn't what p99 is measuring.
 */
function dataCeilingFor(rt: Pick<GuardrailState, "observed_p99_rate" | "row_count">): number | null {
  if (rt.row_count < MIN_ROWS_TO_TRUST_P99) return null;
  if (!rt.observed_p99_rate || rt.observed_p99_rate <= 0) return null;
  const ceiling = Math.round((rt.observed_p99_rate * 1.5) / 10) * 10;
  return ceiling > 0 ? ceiling : null;
}

// Same symbols the change log uses (src/lib/changelog-route-helpers.ts,
// which Deno can't import).
const CURRENCY_SYMBOLS: Record<string, string> = { USD: "$", EUR: "€", GBP: "£" };

/** An amount in rationale copy, in the hotel's own currency. */
function money(amount: number, currency: string | null): string {
  const symbol = currency ? (CURRENCY_SYMBOLS[currency] ?? `${currency} `) : "$";
  const cents = Number.isInteger(amount) ? 0 : 2;
  return `${symbol}${amount.toLocaleString("en-US", { minimumFractionDigits: cents, maximumFractionDigits: 2 })}`;
}

/**
 * Only fills gaps. A guardrail someone actually set — any non-default value —
 * is their call and never questioned here. A gap gets the owner's own
 * strategy answer when they gave one, and otherwise the number the room
 * type's own history supports: the same floor and ceiling a first import
 * would have written. Each rationale says which of the two it came from.
 */
export function computeGuardrailSuggestions(
  roomTypes: GuardrailState[],
  strategy: { floor: number | null; ceiling: number | null },
  /** Room types the same analysis flagged as probably-not-rooms — don't
   *  suggest guardrails for something we're also suggesting excluding. */
  suspectRoomTypeIds: ReadonlySet<string> = new Set(),
  /** The hotel's currency code, for the amounts in the rationale. */
  currency: string | null = null,
): GuardrailSuggestion[] {
  const out: GuardrailSuggestion[] = [];
  const m = (amount: number) => money(amount, currency);
  for (const rt of roomTypes) {
    if (suspectRoomTypeIds.has(rt.room_type_id)) continue;
    const name = rt.name || "This room type";

    // Computed before either suggestion is pushed (but pushed in the
    // original floor-then-ceiling order below): the hotel-wide strategy
    // floor answer has no idea what THIS room type's own rates are, and a
    // cheaper room type (or one still at schema defaults after a refresh,
    // which skips the strategy projection entirely) can have a p99-derived
    // ceiling below that floor. The pair would be impossible to accept —
    // whichever field is applied second violates floor<=ceiling and the
    // findings route 500s on it — so the floor suggestion below must know
    // the ceiling target ahead of time, same discipline
    // computeInitialGuardrails already applies.
    let ceiling: { value: number; rationale: string } | null = null;
    if (rt.ceiling_price >= CEILING_UNSET_MIN) {
      const trustedP99 = rt.row_count >= MIN_ROWS_TO_TRUST_P99 ? rt.observed_p99_rate : null;
      const fromData = dataCeilingFor(rt);
      if (strategy.ceiling && strategy.ceiling > (trustedP99 ?? 0)) {
        ceiling = {
          value: strategy.ceiling,
          rationale: `You said the most you'd charge for a night is ${m(strategy.ceiling)}, so MAYA suggests that as the ceiling.`,
        };
      } else if (fromData != null) {
        ceiling = {
          value: fromData,
          rationale: `${name} has rarely sold for more than ${m(Math.round(trustedP99 ?? 0))} a night, so MAYA suggests a ceiling of ${m(fromData)}.`,
        };
      }
    }

    // A strategy answer is the owner's own number and wins outright. When it
    // can't fit under this room type's ceiling, no floor is suggested at all
    // rather than a lower one they said they'd never take; the data floor
    // only fills in for an owner who never answered.
    let floor: { value: number; rationale: string } | null = null;
    if (rt.floor_price <= FLOOR_UNSET_MAX) {
      if (strategy.floor && strategy.floor > 0) {
        floor = {
          value: strategy.floor,
          rationale: `You said the lowest rate you'd accept is ${m(strategy.floor)}, so MAYA suggests that as the floor.`,
        };
      } else {
        const fromData = dataFloorFor(rt);
        if (fromData != null) {
          floor = {
            value: fromData,
            rationale: `${name} has typically sold for ${m(Math.round(rt.observed_median_rate ?? 0))} a night, so MAYA suggests a floor of ${m(fromData)}.`,
          };
        }
      }
    }

    if (floor) {
      // Whatever ceiling this room type is about to have (the target just
      // computed, an already-set ceiling, or failing that its own observed
      // p99) must clear the floor strictly — equal would pin the room to a
      // single fixed price, which passes the DB check but is its own kind
      // of wrong.
      const effectiveCeiling =
        ceiling?.value ?? (rt.ceiling_price < CEILING_UNSET_MIN ? rt.ceiling_price : rt.observed_p99_rate);
      if (effectiveCeiling == null || floor.value < effectiveCeiling) {
        out.push({
          suggestion_type: "set_guardrail",
          room_type_id: rt.room_type_id,
          room_type_name: rt.name,
          field: "floor_price",
          current: rt.floor_price,
          suggested: floor.value,
          rationale: floor.rationale,
        });
      }
    }

    // And the other way round: a ceiling at or under a floor someone already
    // set can never be accepted either, same as computeInitialGuardrails.
    if (ceiling && ceiling.value > rt.floor_price) {
      out.push({
        suggestion_type: "set_guardrail",
        room_type_id: rt.room_type_id,
        room_type_name: rt.name,
        field: "ceiling_price",
        current: rt.ceiling_price,
        suggested: ceiling.value,
        rationale: ceiling.rationale,
      });
    }
  }
  return out;
}

/* ── Initial (first-run) guardrails ──────────────────────────── */

/** Same shape as a refresh reads: the median now rides on GuardrailState. */
export type InitialGuardrailInput = GuardrailState;

export type InitialGuardrail = {
  room_type_id: string;
  field: "floor_price" | "ceiling_price";
  value: number;
};

/**
 * First-run gap-filling: data-derived floors and ceilings for room types
 * still at schema defaults AFTER the strategy answers were projected.
 * Room types whose guardrails were set by a human (or by strategy answers)
 * are untouched; suspect room types are skipped — no point fitting
 * guardrails to something the same analysis says is probably not a room.
 * The numbers themselves come from dataFloorFor and dataCeilingFor, the
 * same ones a refresh suggests.
 */
export function computeInitialGuardrails(
  roomTypes: InitialGuardrailInput[],
  suspectRoomTypeIds: ReadonlySet<string> = new Set(),
): InitialGuardrail[] {
  const out: InitialGuardrail[] = [];
  for (const rt of roomTypes) {
    if (suspectRoomTypeIds.has(rt.room_type_id)) continue;

    // Ceiling first so the floor below can respect it. The strategy
    // projection (which runs immediately before this) can already have set
    // floor_price above what this room type's own rates support — a
    // data-derived ceiling below that floor violates the DB's floor<=ceiling
    // check constraint and would be silently rejected on write. Skip it
    // rather than propose a patch that can never land: the room type keeps
    // no cap, but at least doesn't waste a doomed write pretending it tried.
    let newCeiling: number | null = null;
    const dataCeiling = rt.ceiling_price >= CEILING_UNSET_MIN ? dataCeilingFor(rt) : null;
    if (dataCeiling != null && dataCeiling > rt.floor_price) {
      newCeiling = dataCeiling;
      out.push({ room_type_id: rt.room_type_id, field: "ceiling_price", value: newCeiling });
    }

    const floor = rt.floor_price <= FLOOR_UNSET_MAX ? dataFloorFor(rt) : null;
    if (floor != null) {
      const effectiveCeiling =
        newCeiling ?? (rt.ceiling_price < CEILING_UNSET_MIN ? rt.ceiling_price : null);
      if (effectiveCeiling === null || floor < effectiveCeiling) {
        out.push({ room_type_id: rt.room_type_id, field: "floor_price", value: floor });
      }
    }
  }
  return out;
}
