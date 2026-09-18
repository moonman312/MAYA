/**
 * Reading the open "this rule keeps adjusting" alerts for a hotel.
 *
 * Shared by the list route and the answer route, which returns the list
 * again so the banner never shows an answer it has already given. The reads
 * run under the caller's session: RLS lets any member of the hotel see them,
 * and only rule_repeat_alert_choose and rule_repeat_alert_resume(_many) can
 * change one. The product event for an answer is here too, because the
 * rules table's "Let it run again" (POST /api/rules/stops) records the same
 * one.
 */

import { isMissingRelationError } from "@/lib/engine/snapshots";
import { currencySymbolFor } from "@/lib/changelog-route-helpers";
import {
  buildRuleAlerts,
  type AlertNightRoomType,
  type AlertNightRow,
  type AlertRow,
  type RuleAlertsView,
} from "@/lib/rule-alerts";
import { createAdminClient, isAdminConfigured } from "@/utils/supabase/admin";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Alerts read at once. More than this on one property is a story in itself. */
export const MAX_ALERTS = 20;
/** Nights read per list. The engine files one row per night and rule version. */
export const MAX_ALERT_NIGHTS = 400;

function roomTypesOf(value: unknown): AlertNightRoomType[] {
  if (!Array.isArray(value)) return [];
  const out: AlertNightRoomType[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.room_type_id !== "string") continue;
    out.push({
      room_type_id: r.room_type_id,
      fires: Number(r.fires) || 0,
      limit: r.limit != null ? Number(r.limit) : null,
      limit_is_default: typeof r.limit_is_default === "boolean" ? r.limit_is_default : null,
      price: r.price != null ? Number(r.price) : null,
    });
  }
  return out;
}

/**
 * The hotel's open alerts and the nights still waiting on an answer. A
 * database without the alert tables yet has nothing to show, which is not an
 * error the dashboard should carry.
 */
export async function loadRuleAlerts(
  supabase: SupabaseClient,
  hotelId: string,
  canManage: boolean,
): Promise<RuleAlertsView> {
  const empty: RuleAlertsView = {
    alerts: [],
    currency_symbol: currencySymbolFor(null),
    can_manage: canManage,
    simulation: false,
  };

  const { data: alertRows, error: alertsError } = await supabase
    .from("rule_repeat_alerts")
    .select("id, rule_id, rule_version, action_direction, opened_at")
    .eq("hotel_id", hotelId)
    .is("resolved_at", null)
    .order("opened_at", { ascending: false })
    .limit(MAX_ALERTS);
  if (alertsError) {
    if (isMissingRelationError(alertsError)) return empty;
    throw alertsError;
  }
  const alerts: AlertRow[] = (alertRows ?? []).map((a) => ({
    id: String(a.id),
    rule_id: String(a.rule_id),
    rule_version: Number(a.rule_version),
    action_direction: a.action_direction === "increase" ? "increase" : "decrease",
    opened_at: String(a.opened_at),
  }));

  const [{ data: settings }, { data: hotel }] = await Promise.all([
    supabase.from("hotel_settings").select("simulation_mode").eq("hotel_id", hotelId).maybeSingle(),
    supabase.from("hotels").select("currency").eq("id", hotelId).maybeSingle(),
  ]);
  const simulation = settings?.simulation_mode !== false;
  const currencySymbol = currencySymbolFor(hotel?.currency ? String(hotel.currency) : null);
  if (alerts.length === 0) {
    return { alerts: [], currency_symbol: currencySymbol, can_manage: canManage, simulation };
  }

  const { data: nightRows, error: nightsError } = await supabase
    .from("rule_repeat_alert_nights")
    .select(
      "alert_id, rule_id, stay_date, fire_count, last_fire_at, window_days, window_bookings, window_expected, " +
        "pickup_metric, pickup_threshold, pickup_window_days, pickup_net, room_types",
    )
    .in("alert_id", alerts.map((a) => a.id))
    .is("choice", null)
    .is("closed_at", null)
    .order("stay_date", { ascending: true })
    .limit(MAX_ALERT_NIGHTS);
  if (nightsError) throw nightsError;
  const nights: AlertNightRow[] = ((nightRows ?? []) as unknown as Record<string, unknown>[]).map((n) => ({
    alert_id: String(n.alert_id),
    rule_id: String(n.rule_id),
    stay_date: String(n.stay_date).slice(0, 10),
    fire_count: Number(n.fire_count),
    last_fire_at: String(n.last_fire_at),
    window_days: n.window_days != null ? Number(n.window_days) : null,
    window_bookings: n.window_bookings != null ? Number(n.window_bookings) : null,
    window_expected: n.window_expected != null ? Number(n.window_expected) : null,
    pickup_metric: n.pickup_metric != null ? String(n.pickup_metric) : null,
    pickup_threshold: n.pickup_threshold != null ? Number(n.pickup_threshold) : null,
    pickup_window_days: n.pickup_window_days != null ? Number(n.pickup_window_days) : null,
    pickup_net: n.pickup_net != null ? Number(n.pickup_net) : null,
    room_types: roomTypesOf(n.room_types),
  }));

  const roomTypeIds = new Set<string>();
  for (const night of nights) for (const rt of night.room_types) roomTypeIds.add(rt.room_type_id);
  const [{ data: rules }, { data: roomTypes }] = await Promise.all([
    supabase.from("pricing_rules").select("id, name").in("id", alerts.map((a) => a.rule_id)),
    roomTypeIds.size > 0
      ? supabase.from("room_types").select("id, name").in("id", [...roomTypeIds])
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
  ]);

  return {
    alerts: buildRuleAlerts({
      alerts,
      nights,
      ruleNames: new Map((rules ?? []).map((r) => [String(r.id), String(r.name)])),
      roomTypeNames: new Map((roomTypes ?? []).map((rt) => [String(rt.id), String(rt.name)])),
      currencySymbol,
      simulation,
    }),
    currency_symbol: currencySymbol,
    can_manage: canManage,
    simulation,
  };
}

/**
 * One product event per answer, and one per "Let it run again" click however
 * many alerts it covered. Analytics never costs an owner their answer: the
 * write has already happened, so a failure here is logged and nothing more
 * (docs/analytics.md).
 */
export async function recordAlertAnswer(
  supabase: SupabaseClient,
  input: {
    /** The route recording it, for the log line. */
    route: string;
    hotelId: string;
    ruleId: string;
    choice: "keep_adjusting" | "stop" | "resume";
    nights: number;
    allNights: boolean;
    simulation: boolean;
  },
): Promise<void> {
  if (!isAdminConfigured()) return;
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const { error } = await createAdminClient().rpc("product_event_emit", {
      p_event: "rule.repeat_alert_answered",
      p_hotel_id: input.hotelId,
      p_user_id: session?.user?.id ?? null,
      p_properties: {
        rule_id: input.ruleId,
        choice: input.choice,
        nights: input.nights,
        all_nights: input.allNights,
        simulation: input.simulation,
      },
      p_source: "app",
    });
    if (error) throw new Error(error.message);
  } catch (e) {
    console.error(
      JSON.stringify({
        fn: input.route,
        step: "product_event",
        error: e instanceof Error ? e.message : String(e),
      }),
    );
  }
}
