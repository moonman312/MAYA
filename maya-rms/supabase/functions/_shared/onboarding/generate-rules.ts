/**
 * Starter pricing rules for "Hold My Hand" onboarding.
 *
 * The whole point: the user finishes onboarding with rules already built
 * and RUNNING — in simulation mode, watching but not touching prices —
 * plus a single prompt to go live. Not an empty rules page.
 *
 * The starter set is the booking-speed ladder: five simple rules that react
 * to how fast each stay date is booking versus what similar past dates did
 * at the same point in their booking curve. No thresholds for the owner to
 * guess — the Observation Engine works out what "normal" means from their
 * own history, and every rule narrates itself in the changelog.
 *
 *   far behind pace (past month)  -> cut 15%,  then wait a week
 *   a bit behind    (past month)  -> trim 7%,  then wait a week
 *   ahead of pace   (past month)  -> raise 10%, brief pause
 *   way ahead       (past week)   -> raise 25%, can repeat every 2 days
 *   sudden surge    (past day)    -> raise 25%, can repeat daily
 *
 * Decreases wait longer than increases on purpose: a surge prices itself
 * back to Normal (higher rate, slower pace), while a dead date can stay
 * dead no matter what — without the pause, cuts would stack to the floor.
 * Floors and ceilings (set alongside these) are the hard stops either way.
 *
 * Never generates when the hotel already has ANY pricing rules — we don't
 * stomp on a revenue manager's work.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type StarterRuleSpec = {
  name: string;
  priority: number;
  condition: {
    occupancy_operator?: "gt";
    occupancy_threshold?: number; // FRACTION (0.75), matching rule_condition
    pickup_operator?: "gt";
    pickup_threshold?: number;
    pickup_window_days?: 1 | 3 | 7;
    pickup_metric?: "room_nights";
    booking_speed_operator?: "at_least" | "at_most" | "is";
    booking_speed_level?: string;
    booking_speed_window_days?: 1 | 7 | 30;
    booking_speed_cooldown_days?: number;
  };
  action: {
    action_type: "percent";
    action_direction: "increase" | "decrease";
    action_value: number;
  };
  is_pickup_rule: boolean;
  explanation: string; // shown to the user: WHY this rule, in their terms
};

/** Days of observed history below which we refuse to generate anything. */
export const MIN_HISTORY_DAYS_FOR_STARTERS = 60;

/**
 * Pure: the booking-speed starter ladder. Every rule is event-style — it
 * fires, the price change sticks, and a per-stay-date cooldown throttles
 * repeats (escalation to a stronger rule stays possible mid-cooldown).
 */
export function computeStarterRules(input: { daysOfHistory: number }): StarterRuleSpec[] {
  if (input.daysOfHistory < MIN_HISTORY_DAYS_FOR_STARTERS) return [];

  return [
    {
      name: "Slow-date rescue",
      priority: 110,
      condition: {
        booking_speed_operator: "at_most",
        booking_speed_level: "much_slower",
        booking_speed_window_days: 30,
        booking_speed_cooldown_days: 7,
      },
      action: { action_type: "percent", action_direction: "decrease", action_value: 15 },
      is_pickup_rule: true,
      explanation:
        "When a night is booking far behind the pace similar nights set, a real 15% cut " +
        "restarts interest. MAYA then waits a week before judging the result, so cuts never pile up.",
    },
    {
      name: "Slow-date trim",
      priority: 105,
      condition: {
        booking_speed_operator: "is",
        booking_speed_level: "slower",
        booking_speed_window_days: 30,
        booking_speed_cooldown_days: 7,
      },
      action: { action_type: "percent", action_direction: "decrease", action_value: 7 },
      is_pickup_rule: true,
      explanation:
        "A night booking a bit behind the usual pace gets a small 7% trim — enough to stay " +
        "competitive without giving the room away. Re-checked a week after each trim.",
    },
    {
      name: "Warm-date bump",
      priority: 115,
      condition: {
        booking_speed_operator: "at_least",
        booking_speed_level: "faster",
        booking_speed_window_days: 30,
        booking_speed_cooldown_days: 3,
      },
      action: { action_type: "percent", action_direction: "increase", action_value: 10 },
      is_pickup_rule: true,
      explanation:
        "A night booking ahead of the pace similar nights set can carry 10% more — " +
        "the demand is already showing up in your own numbers.",
    },
    {
      name: "Hot-week surge",
      priority: 125,
      condition: {
        booking_speed_operator: "at_least",
        booking_speed_level: "much_faster",
        booking_speed_window_days: 7,
        booking_speed_cooldown_days: 2,
      },
      action: { action_type: "percent", action_direction: "increase", action_value: 25 },
      is_pickup_rule: true,
      explanation:
        "When the past week runs much faster than similar nights ever did, raise 25% and ride " +
        "the wave — it can step up again every couple of days while demand holds.",
    },
    {
      name: "Sudden-spike catcher",
      priority: 130,
      condition: {
        booking_speed_operator: "at_least",
        booking_speed_level: "surging",
        booking_speed_window_days: 1,
        booking_speed_cooldown_days: 1,
      },
      action: { action_type: "percent", action_direction: "increase", action_value: 25 },
      is_pickup_rule: true,
      explanation:
        "Bookings pouring in within a single day — a concert announcement, a viral mention — " +
        "trigger an immediate 25% raise, repeatable daily while the rush lasts. Your ceiling is the cap.",
    },
  ];
}

/**
 * Occupancy reference marks from the property's own distribution — used by
 * refresh-mode suggestions to sanity-check EXISTING occupancy rules ("your
 * rule fires at 70%, but your history says nights get scarce at 85%").
 * Starter generation no longer creates occupancy rules; this survives only
 * for that comparison.
 */
export function computeOccupancyReference(
  dailyOccupancyFractions: number[],
): { surgePct: number; peakPct: number } | null {
  const occ = [...dailyOccupancyFractions].sort((a, b) => a - b);
  if (occ.length < MIN_HISTORY_DAYS_FOR_STARTERS) return null;
  const percentile = (p: number) => occ[Math.min(occ.length - 1, Math.floor(p * occ.length))];
  const roundTo5 = (pct: number) => Math.round(pct / 5) * 5;
  const surgePct = Math.min(85, Math.max(60, roundTo5(percentile(0.8) * 100)));
  const peakPct = Math.min(95, Math.max(surgePct + 10, roundTo5(percentile(0.95) * 100)));
  return { surgePct, peakPct };
}

/** Create the rules for a hotel. Returns specs created, or [] if skipped. */
export async function generateStarterRules(
  supabase: SupabaseClient,
  hotelId: string,
): Promise<StarterRuleSpec[]> {
  // Hard guard: never add to an existing rule set.
  const { count: existingRules } = await supabase
    .from("pricing_rules")
    .select("id", { count: "exact", head: true })
    .eq("hotel_id", hotelId);
  if ((existingRules ?? 0) > 0) return [];

  const [{ data: dailyRaw }, { data: roomTypes }] = await Promise.all([
    supabase.rpc("onboarding_daily_room_nights", { p_hotel_id: hotelId }),
    supabase
      .from("room_types")
      .select("id, total_rooms")
      .eq("hotel_id", hotelId)
      .eq("is_active", true),
  ]);

  const allRoomTypeIds = (roomTypes ?? []).map((rt) => String(rt.id));
  if (allRoomTypeIds.length === 0) return [];

  const today = new Date().toISOString().slice(0, 10);
  const daysOfHistory = (dailyRaw ?? []).filter(
    (r: { stay_date: string }) => String(r.stay_date) < today,
  ).length;

  const specs = computeStarterRules({ daysOfHistory });
  if (specs.length === 0) return [];

  for (const spec of specs) {
    const { data: ruleRow, error: insErr } = await supabase
      .from("pricing_rules")
      .insert({
        hotel_id: hotelId,
        name: spec.name,
        priority: spec.priority,
        is_active: true, // live logic, but the hotel is in simulation mode
        version: 1,
        start_date: null,
        end_date: null,
        is_annual: false,
        dow_mask: 127,
        action_type: spec.action.action_type,
        action_direction: spec.action.action_direction,
        action_value: spec.action.action_value,
        is_pickup_rule: spec.is_pickup_rule,
      })
      .select("id")
      .single();
    if (insErr || !ruleRow) {
      throw new Error(`starter rule insert failed: ${insErr?.message}`);
    }
    const ruleId = String(ruleRow.id);

    const { error: condErr } = await supabase
      .from("rule_condition")
      .insert({ rule_id: ruleId, ...spec.condition });
    if (condErr) throw new Error(`rule_condition insert failed: ${condErr.message}`);

    const joins = allRoomTypeIds.map((rtId) => ({ rule_id: ruleId, room_type_id: rtId }));
    const { error: sigErr } = await supabase.from("rule_signal_room_type").insert(joins);
    if (sigErr) throw new Error(`rule_signal_room_type insert failed: ${sigErr.message}`);
    const { error: affErr } = await supabase.from("rule_affected_room_type").insert(joins);
    if (affErr) throw new Error(`rule_affected_room_type insert failed: ${affErr.message}`);
  }

  return specs;
}
