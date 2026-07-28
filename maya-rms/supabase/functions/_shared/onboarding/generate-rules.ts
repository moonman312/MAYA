/**
 * Starter pricing rules, generated from the property's own history.
 *
 * The whole point of "Hold My Hand": the user finishes onboarding with rules
 * already built and RUNNING — in simulation mode, watching but not touching
 * prices — plus a single prompt to go live. Not an empty rules page.
 *
 * Thresholds come from their data, not from folklore:
 *   - Surge threshold  = ~p80 of their historical daily occupancy
 *   - Peak threshold   = ~p95
 *   - Pickup threshold = scaled to property size
 * Aggressiveness follows their confidence answer: "automate what I do" gets
 * gentler bumps than "find money I'm leaving on the table".
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
  };
  action: { action_type: "percent"; action_direction: "increase"; action_value: number };
  is_pickup_rule: boolean;
  explanation: string; // shown to the user: WHY this rule, from THEIR data
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

function roundTo5(pct: number): number {
  return Math.round(pct / 5) * 5;
}

/** Pure: decide the rules from aggregate inputs (unit-testable). */
export function computeStarterRules(input: {
  dailyOccupancyFractions: number[]; // one entry per observed stay date
  totalRooms: number;
  pricingConfidence: "automate_current" | "find_upside" | null;
}): StarterRuleSpec[] {
  const occ = [...input.dailyOccupancyFractions].sort((a, b) => a - b);
  if (occ.length < 60) return []; // not enough history to say anything honest

  const bold = input.pricingConfidence === "find_upside";
  const surgeBump = bold ? 12 : 8;
  const peakBump = bold ? 15 : 10;
  const pickupBump = bold ? 8 : 5;

  // Their own busy days, clamped to sane bounds.
  const surgePct = Math.min(85, Math.max(60, roundTo5(percentile(occ, 0.8) * 100)));
  const peakPct = Math.min(95, Math.max(surgePct + 10, roundTo5(percentile(occ, 0.95) * 100)));

  // Pickup: a burst worth reacting to, scaled to property size.
  const pickupThreshold = Math.max(3, Math.round(input.totalRooms * 0.15));

  return [
    {
      name: "Busy-day bump",
      priority: 100,
      condition: { occupancy_operator: "gt", occupancy_threshold: surgePct / 100 },
      action: { action_type: "percent", action_direction: "increase", action_value: surgeBump },
      is_pickup_rule: false,
      explanation:
        `Historically, only about 1 in 5 of your nights fills past ${surgePct}%. ` +
        `When a night is tracking that well, it can carry ${surgeBump}% more.`,
    },
    {
      name: "Nearly-full premium",
      priority: 110,
      condition: { occupancy_operator: "gt", occupancy_threshold: peakPct / 100 },
      action: { action_type: "percent", action_direction: "increase", action_value: peakBump },
      is_pickup_rule: false,
      explanation:
        `Above ${peakPct}% you're nearly sold out — your rarest nights. ` +
        `The last rooms on those nights are worth a further ${peakBump}%.`,
    },
    {
      name: "Demand-spike catcher",
      priority: 120,
      condition: {
        pickup_operator: "gt",
        pickup_threshold: pickupThreshold,
        pickup_window_days: 3,
        pickup_metric: "room_nights",
      },
      action: { action_type: "percent", action_direction: "increase", action_value: pickupBump },
      is_pickup_rule: true,
      explanation:
        `If a night picks up more than ${pickupThreshold} bookings in 3 days, something is ` +
        `driving demand (an event, a mention, a group). Ride it with ${pickupBump}% per surge.`,
    },
  ];
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

  const [{ data: dailyRaw }, { data: roomTypes }, { data: settings }] = await Promise.all([
    supabase.rpc("onboarding_daily_room_nights", { p_hotel_id: hotelId }),
    supabase
      .from("room_types")
      .select("id, total_rooms")
      .eq("hotel_id", hotelId)
      .eq("is_active", true),
    supabase
      .from("hotel_settings")
      .select("pricing_confidence")
      .eq("hotel_id", hotelId)
      .maybeSingle(),
  ]);

  const totalRooms = (roomTypes ?? []).reduce(
    (sum, rt) => sum + (Number(rt.total_rooms) || 0),
    0,
  );
  if (totalRooms === 0) return [];

  const today = new Date().toISOString().slice(0, 10);
  const dailyOccupancyFractions = (dailyRaw ?? [])
    .filter((r: { stay_date: string }) => String(r.stay_date) < today) // history only
    .map((r: { room_nights: number | string }) =>
      Math.min(1, Number(r.room_nights) / totalRooms),
    );

  const specs = computeStarterRules({
    dailyOccupancyFractions,
    totalRooms,
    pricingConfidence:
      (settings?.pricing_confidence as "automate_current" | "find_upside" | null) ?? null,
  });
  if (specs.length === 0) return [];

  const allRoomTypeIds = (roomTypes ?? []).map((rt) => String(rt.id));

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
