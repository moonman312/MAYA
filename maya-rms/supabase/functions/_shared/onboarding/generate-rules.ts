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
 *   far behind pace (past month)  -> cut 15%,  then waits a week
 *   a bit behind    (past month)  -> trim 7%,  then waits a week
 *   ahead of pace   (past month)  -> raise 10%, then waits 3 days
 *   way ahead       (past week)   -> raise 25%, then waits 2 days
 *   sudden surge    (past day)    -> raise 25%, then waits a day
 *
 * Each wait is per night and room type. Once it is over and the condition
 * still holds, the rule adjusts that night again, so a night that stays far
 * behind keeps getting cut. Once a rule has adjusted one night three times
 * MAYA puts that night in front of the owner and asks whether to carry on;
 * until they answer, the rule carries on.
 *
 * Decreases wait longer than increases on purpose: a surge prices itself
 * back to Normal (higher rate, slower pace), while a dead date can stay
 * dead no matter what, so its cuts want more room between them. Floors and
 * ceilings (set alongside these) are the hard stops either way.
 *
 * Never generates when the hotel already has ANY pricing rules — we don't
 * stomp on a revenue manager's work.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Room-nights per stay date for the whole book, oldest first.
 *
 * Paged: ten years of history is over 3,600 dates, and an unpaged rpc stops
 * at PostgREST's 1,000 rows, which kept only the OLDEST dates. Closed periods,
 * the occupancy reference and the days-of-history count were all computed as
 * if the last years of the book did not exist. A failed page throws, so the
 * worker retries instead of analysing a fragment.
 */
export async function loadDailyRoomNights(
  supabase: SupabaseClient,
  hotelId: string,
): Promise<{ stay_date: string; room_nights: number }[]> {
  const PAGE = 1000;
  const out: { stay_date: string; room_nights: number }[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .rpc("onboarding_daily_room_nights", { p_hotel_id: hotelId })
      .order("stay_date", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`onboarding_daily_room_nights failed: ${error.message}`);
    const rows = (data ?? []) as { stay_date: string; room_nights: number | string }[];
    for (const r of rows) out.push({ stay_date: String(r.stay_date), room_nights: Number(r.room_nights) });
    if (rows.length < PAGE) break;
  }
  return out;
}

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
 * Pure: the booking-speed starter ladder. Every rule is event-style: it
 * fires, the price change sticks, and its wait holds it off that night and
 * room type until the wait is over (escalation to a stronger rule stays
 * possible while it waits).
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
        "restarts interest. MAYA waits a week before judging the result, then cuts again if the " +
        "night is still that far behind. It tells you once it has cut the same night three times.",
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
        "A night booking a bit behind the usual pace gets a small 7% trim, enough to stay " +
        "competitive without giving the room away. MAYA re-checks a week after each trim and " +
        "trims again if the night is still behind.",
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
        "A night booking ahead of the pace similar nights set can carry 10% more: the demand " +
        "is already showing up in your own numbers. MAYA waits 3 days, then raises again if the " +
        "night is still ahead. If enough of those bookings cancel, the raise comes back off.",
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
        "the wave. It steps up again every couple of days while demand holds, and MAYA tells you " +
        "once it has raised the same night three times.",
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
        "Bookings pouring in within a single day, a concert announcement or a viral mention, " +
        "trigger an immediate 25% raise, repeated daily while the rush lasts. Your ceiling is the " +
        "cap, and MAYA tells you once it has raised the same night three times.",
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

/**
 * Active room types that count as rooms (counts_as_room is not false).
 * Before the migration that adds the column, the select fails and every
 * active type counts, which is what starter rules always did. Logged, never
 * thrown: onboarding must finish whichever of code or SQL deployed first.
 */
async function loadCountingRoomTypeIds(
  supabase: SupabaseClient,
  hotelId: string,
): Promise<string[]> {
  const withFlag = await supabase
    .from("room_types")
    .select("id, counts_as_room")
    .eq("hotel_id", hotelId)
    .eq("is_active", true);
  if (!withFlag.error) {
    return (withFlag.data ?? [])
      .filter((rt) => rt.counts_as_room !== false)
      .map((rt) => String(rt.id));
  }
  console.error(
    JSON.stringify({
      fn: "generateStarterRules",
      step: "counts_as_room",
      hotelId,
      error: withFlag.error.message,
      message:
        "Could not read room_types.counts_as_room; every active room type joins the starter rules. " +
        "If the column is missing, run 99_supabase_migration_room_type_counts_as_room_v1.sql.",
    }),
  );
  const { data } = await supabase
    .from("room_types")
    .select("id")
    .eq("hotel_id", hotelId)
    .eq("is_active", true);
  return (data ?? []).map((rt) => String(rt.id));
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

  const [dailyRaw, roomTypes] = await Promise.all([
    loadDailyRoomNights(supabase, hotelId),
    loadCountingRoomTypeIds(supabase, hotelId),
  ]);

  // Starter rules measure and price only what counts as a room. A court the
  // heuristic (or the owner) flagged never joins either set.
  const allRoomTypeIds = roomTypes;
  if (allRoomTypeIds.length === 0) return [];

  const today = new Date().toISOString().slice(0, 10);
  const daysOfHistory = dailyRaw.filter((r) => r.stay_date < today).length;

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
