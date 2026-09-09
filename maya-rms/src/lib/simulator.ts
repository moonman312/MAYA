/**
 * Rate Simulator — a what-if run of the real pricing engine.
 *
 * The point of this module is that it imports the SAME pure functions the
 * engine imports: ruleScopeMatches, ruleConditionsMatch, applyAdjustments and
 * clampPrice. The old simulator had its own matcher (a port of a retired Python
 * script) whose operators disagreed with the engine's — a bare "80" meant
 * "== 80" there and "always true" once persisted, so the same rule could be
 * previewed one way and priced another. Nothing here re-implements pricing
 * logic; it only assembles the inputs the engine would have read from the
 * database and reports what came back.
 *
 * What it deliberately does NOT model:
 *   • Ladder state. A real ladder rule fires on the TRANSITION into its
 *     condition and holds until the condition breaks, so it cannot stack on
 *     itself. A single what-if has no previous run to transition from, so this
 *     answers "what does this stay night look like once everything has settled"
 *     — which is the steady state a ladder converges on anyway.
 *   • Pickup competition. The engine picks one winner per stay night by
 *     specificity; here every matching pickup rule contributes, so the preview
 *     is the upper bound rather than the settled result.
 * Both are called out in the UI rather than hidden.
 */

import { ruleConditionsMatch } from "@/lib/engine/conditions";
import { computeDta, computeOccupancy } from "@/lib/engine/metrics";
import { applyAdjustments, clampPrice } from "@/lib/engine/pricing";
import { ruleScopeMatches } from "@/lib/engine/scope";
import type { AdjustmentSpec, RuleMetrics } from "@/lib/engine/types";
import { bookingSpeedLabel, bookingSpeedRank, isBookingSpeed } from "@/lib/observations/booking-speed";
import type { EngineRule } from "@/types/domain";

export type SimRoomType = {
  id: string;
  name: string;
  total_rooms: number;
  floor_price: number;
  ceiling_price: number;
};

/** One editable row of the scenario: the owner's made-up numbers for a room type. */
export type SimRoomInput = {
  /** The rate the night would sell at before any rule touches it. */
  basePrice: number;
  /** 0–100, as typed. Converted to the engine's 0–1 fraction here. */
  occupancyPct: number;
  /** Rooms picked up in the rule's pickup window. Drives pickup conditions. */
  pickupUnits: number;
};

export type SimScenario = {
  /** The night being priced. Drives days-to-arrival, the date window and the DOW mask. */
  stayDate: string;
  /** Hotel-local "today". Days-to-arrival is stayDate minus this. */
  evalDate: string;
  hotelTimeZone: string;
  rooms: Record<string, SimRoomInput>;
  /**
   * A BookingSpeed level key, or null for "no history". Null is not a neutral
   * default — it sets the block reason, so booking-speed rules correctly refuse
   * to fire on an observation the engine could not have made.
   */
  bookingSpeedLevel: string | null;
  bookingSpeedWindowDays: number;
};

export type SimSkipReason =
  | "date_window"
  | "day_of_week"
  | "no_room_types"
  | "not_affected"
  | "no_occupancy_data"
  | "condition_not_met";

export const SIM_SKIP_LABEL: Record<SimSkipReason, string> = {
  date_window: "Outside the rule's date window",
  day_of_week: "This day of the week is excluded",
  no_room_types: "Rule has no room types attached",
  not_affected: "Doesn't price this room type",
  no_occupancy_data: "No occupancy for its signal room types",
  condition_not_met: "Conditions not met",
};

export type SimRuleOutcome = {
  ruleId: string;
  ruleName: string;
  /** False for a rule that is switched off in the Rules tab — previewed anyway. */
  isActive: boolean;
  kind: "ladder" | "pickup";
  fired: boolean;
  skipReason: SimSkipReason | null;
  /** The occupancy this rule actually saw, across its signal room types. */
  occupancySeen: number | null;
  dta: number;
};

export type SimRoomResult = {
  roomType: SimRoomType;
  basePrice: number;
  ladder: AdjustmentSpec[];
  pickup: AdjustmentSpec[];
  outcomes: SimRuleOutcome[];
  preClampPrice: number;
  finalPrice: number;
  clampedBy: "ceiling" | "floor" | "none";
};

function specFor(rule: EngineRule): AdjustmentSpec {
  return {
    rule_id: rule.id,
    action_kind: rule.action_type,
    action_direction: rule.action_direction,
    action_value: rule.action_value,
  };
}

/**
 * Build the metrics a rule would have seen, from the scenario the owner typed.
 *
 * Occupancy and pickup are aggregated across the rule's SIGNAL room types, not
 * the ones it prices — a rule can watch the suites and move the standards, and
 * flattening that distinction would quietly change which rules fire.
 */
function metricsForRule(
  rule: EngineRule,
  roomTypes: SimRoomType[],
  scenario: SimScenario,
): RuleMetrics {
  const byId = new Map(roomTypes.map((rt) => [rt.id, rt]));

  const snapshots = new Map<string, { booked_units: number; sellable_units: number }>();
  let pickupUnits = 0;
  let pickupRevenue = 0;
  let sawAnySignal = false;

  for (const rtId of rule.signal_room_type_ids) {
    const rt = byId.get(rtId);
    const input = scenario.rooms[rtId];
    if (!rt || !input) continue;
    sawAnySignal = true;
    // Every one of these can arrive as NaN: an emptied number input reports "",
    // and Number("") is NaN. One NaN would make occupancy NaN, and every
    // comparison against NaN is false, so rules would silently stop firing with
    // nothing on screen explaining why.
    const occPct = safeNumber(input.occupancyPct);
    const picked = safeNumber(input.pickupUnits);
    snapshots.set(rtId, {
      sellable_units: rt.total_rooms,
      booked_units: Math.round((occPct / 100) * rt.total_rooms),
    });
    pickupUnits += picked;
    // The scenario only asks for room nights. A revenue-metric rule needs
    // dollars, so value those nights at the base price the owner set for that
    // room type — the closest honest reading of "these rooms picked up".
    pickupRevenue += picked * safeNumber(input.basePrice);
  }

  const occupancy = computeOccupancy(snapshots, rule.signal_room_type_ids);
  const dta = computeDta(scenario.stayDate, scenario.evalDate);

  const level = scenario.bookingSpeedLevel;
  const hasSpeed = level != null && isBookingSpeed(level);

  return {
    occupancy,
    dta,
    net_pickup_units: sawAnySignal ? pickupUnits : null,
    net_pickup_revenue: sawAnySignal ? Math.round(pickupRevenue * 100) / 100 : null,
    pickup_block_reason: sawAnySignal ? null : "no_active_signal_room_types",
    booking_speed: hasSpeed
      ? {
          speed: level,
          rank: bookingSpeedRank(level),
          label: bookingSpeedLabel(level),
          // Display-only in a simulation: nobody measured a real pace here.
          recent: 0,
          expected: 0,
          window_days: scenario.bookingSpeedWindowDays,
          method: "simulated",
        }
      : null,
    booking_speed_block_reason: hasSpeed ? null : "insufficient_data",
  };
}

/**
 * Price every room type in the scenario under the given rules.
 *
 * Rules that are switched off are evaluated as though they were on — previewing
 * a rule you have not committed to is the main reason to open this tab — and
 * each result carries isActive so the UI can say so. Everything else about the
 * rule (date window, day-of-week mask, room types, conditions) is checked for
 * real.
 *
 * `roomTypes` must be the property's WHOLE active catalog, not a subset. It is
 * both the list of rows to price and the lookup for each rule's signal set, so
 * a partial list makes rules that watch an omitted room type read as having no
 * occupancy data and quietly stop firing.
 */
export function simulate(
  rules: EngineRule[],
  roomTypes: SimRoomType[],
  scenario: SimScenario,
): SimRoomResult[] {
  // A half-typed date reaches here as "" — an <input type="date"> reports that
  // for any incomplete value. Passing it on would reach Intl.DateTimeFormat
  // with an Invalid Date and throw, and since this runs inside a useMemo during
  // render, the throw would unmount the whole dashboard mid-edit. Price the
  // rooms with no rules instead and let the caller say "pick a date".
  const datesUsable = isIsoDate(scenario.stayDate) && isIsoDate(scenario.evalDate);
  const evalTs = `${scenario.evalDate}T12:00:00.000Z`;

  // Everything a rule's verdict depends on is a function of (rule, scenario) —
  // never of the room type being priced. Computing it inside the room-type loop
  // repeated the whole thing once per room, which on a 130-room-type property
  // with 15 rules meant ~2000 Intl.DateTimeFormat constructions per keystroke.
  const perRule = datesUsable
    ? rules.map((rule) => {
        const metrics = metricsForRule(rule, roomTypes, scenario);
        const hasRoomTypes =
          rule.signal_room_type_ids.length > 0 && rule.affected_room_type_ids.length > 0;
        const inScope =
          hasRoomTypes &&
          ruleScopeMatches({ ...rule, is_active: true }, scenario.stayDate, evalTs, scenario.hotelTimeZone);
        // Scope folds the date window and the DOW mask together. Re-test the
        // window alone so the reason shown is the one that actually bit.
        const windowOnly =
          hasRoomTypes && !inScope
            ? ruleScopeMatches(
                { ...rule, is_active: true, dow_mask: 127 },
                scenario.stayDate,
                evalTs,
                scenario.hotelTimeZone,
              )
            : false;
        const affected = new Set(rule.affected_room_type_ids);
        return {
          rule,
          metrics,
          hasRoomTypes,
          inScope,
          windowOnly,
          affected,
          conditionsMet: ruleConditionsMatch(rule, metrics),
          kind: (rule.is_pickup_rule ? "pickup" : "ladder") as "ladder" | "pickup",
        };
      })
    : [];

  return roomTypes.map((rt) => {
    const input = scenario.rooms[rt.id];
    const basePrice = safeNumber(input?.basePrice);

    const outcomes: SimRuleOutcome[] = [];
    const ladderRules: EngineRule[] = [];
    const pickupRules: EngineRule[] = [];

    for (const p of perRule) {
      let skip: SimSkipReason | null = null;

      if (!p.hasRoomTypes) {
        skip = "no_room_types";
      } else if (!p.affected.has(rt.id)) {
        skip = "not_affected";
      } else if (!p.inScope) {
        skip = p.windowOnly ? "day_of_week" : "date_window";
      } else if (p.rule.condition.occupancy_operator && p.metrics.occupancy === null) {
        skip = "no_occupancy_data";
      } else if (!p.conditionsMet) {
        skip = "condition_not_met";
      }

      outcomes.push({
        ruleId: p.rule.id,
        ruleName: p.rule.name,
        isActive: p.rule.is_active,
        kind: p.kind,
        occupancySeen: p.metrics.occupancy,
        dta: p.metrics.dta,
        fired: skip === null,
        skipReason: skip,
      });
      if (skip !== null) continue;

      if (p.kind === "ladder") ladderRules.push(p.rule);
      else pickupRules.push(p.rule);
    }

    // The engine composes ladder effects in ascending rule_id order and pickup
    // effects in applied_at order. A what-if applies everything at the same
    // instant, so rule_id is the faithful tiebreak for both.
    const byId = (a: EngineRule, b: EngineRule) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const ladder = [...ladderRules].sort(byId).map(specFor);
    const pickup = [...pickupRules].sort(byId).map(specFor);

    const preClampPrice = applyAdjustments(basePrice, ladder, pickup);
    const { final, clamped_by } = clampPrice(preClampPrice, rt.floor_price, rt.ceiling_price);

    return {
      roomType: rt,
      basePrice,
      ladder,
      pickup,
      outcomes,
      preClampPrice,
      finalPrice: final,
      clampedBy: clamped_by,
    };
  });
}

/** A real YYYY-MM-DD, not "" and not "2026-13-40". */
export function isIsoDate(s: string | null | undefined): boolean {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/** An empty number input reports NaN; a price of NaN poisons the whole row. */
function safeNumber(n: number | undefined): number {
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

/** "YYYY-MM-DD" for a date `days` from today, in UTC calendar terms. */
export function isoDatePlus(days: number, from: Date = new Date()): string {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Today's date on the HOTEL's calendar, which is what days-to-arrival is
 * measured from.
 *
 * The engine reads hotels.timezone and derives its local date the same way
 * (evaluate.ts). Using the viewer's UTC date instead puts the preview a day off
 * for every evening at a US property — a "book within 7 days" rule would show
 * as firing on a night the real run scores at 8 days out.
 */
export function hotelToday(hotelTimeZone: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: hotelTimeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    // An unknown IANA name must not take down the tab.
    return isoDatePlus(0, now);
  }
}
