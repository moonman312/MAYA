/**
 * The pricing window a hotel's last scheduled tick used, for copy that names
 * it ("sending now", "sent when the date comes into the window").
 *
 * The window's length is one switch, MAYA_PRICING_HORIZON_DAYS, set for the
 * scheduled syncs. The app reads what the last daily pass was started with
 * (hotel_pricing_state.pass_horizon_days, 99_supabase_migration_pricing_cadence_v1.sql)
 * so its copy always matches what the syncs really do, and falls back to its
 * own copy of the switch when there is no pass yet or no table.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { pricingHorizonDays } from "./pricing-window";

export async function hotelPricingHorizon(admin: SupabaseClient, hotelId: string): Promise<number> {
  try {
    const { data, error } = await admin
      .from("hotel_pricing_state")
      .select("pass_horizon_days")
      .eq("hotel_id", hotelId)
      .maybeSingle();
    const days = !error && data?.pass_horizon_days != null ? Math.floor(Number(data.pass_horizon_days)) : NaN;
    if (Number.isFinite(days) && days > 0) return days;
  } catch {
    // Fall through to the switch.
  }
  return pricingHorizonDays();
}
