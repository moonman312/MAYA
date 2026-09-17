/**
 * GET /api/rules/stops — the nights still to come that the owner has told a
 * rule to stop adjusting.
 *
 * Answering "stop" on an alert is permanent for that rule version: the engine
 * reads it before every fire (isStoppedOnNight) and skips the night. Nothing
 * else in the product used to show it, so a rule could sit on the rules page
 * marked On, with its conditions and its fire count, while doing nothing at
 * all on a dozen nights. This is what the rules table's "Stopped on N nights"
 * chip reads, and the chip is where the owner lets the rule run again.
 *
 * Only the current version's answers count, the same as the engine. Nights
 * that have passed are left out: nothing can fire on them anyway.
 */

import { dbErrorResponse } from "@/lib/api-guards";
import { isMissingRelationError } from "@/lib/engine/snapshots";
import { requireSupabaseHotel } from "@/lib/require-supabase-hotel";
import type { RuleStops } from "@/lib/rule-alerts";
import { hotelToday } from "@/lib/simulator";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

/** Stopped nights read at once. A rule stopped on more than this is a story in itself. */
export const MAX_STOPPED_NIGHTS = 400;

export async function GET() {
  const ctx = await requireSupabaseHotel(await cookies());
  if (!ctx.ok) return ctx.response;

  try {
    const { data: hotel } = await ctx.supabase
      .from("hotels")
      .select("timezone")
      .eq("id", ctx.hotelId)
      .maybeSingle();
    const today = hotelToday(String(hotel?.timezone ?? "UTC"));

    const { data: rows, error } = await ctx.supabase
      .from("rule_repeat_alert_nights")
      .select("alert_id, rule_id, rule_version, stay_date")
      .eq("hotel_id", ctx.hotelId)
      .eq("choice", "stop")
      .gte("stay_date", today)
      .order("stay_date", { ascending: true })
      .limit(MAX_STOPPED_NIGHTS);
    if (error) {
      // A database without the alert tables yet has nothing to show, which is
      // not an error the rules page should carry.
      if (isMissingRelationError(error)) return NextResponse.json([]);
      throw error;
    }
    const answered = (rows ?? []) as Record<string, unknown>[];
    if (answered.length === 0) return NextResponse.json([]);

    const { data: rules } = await ctx.supabase
      .from("pricing_rules")
      .select("id, version")
      .in("id", [...new Set(answered.map((r) => String(r.rule_id)))]);
    const versions = new Map((rules ?? []).map((r) => [String(r.id), Number(r.version)]));

    const byRule = new Map<string, RuleStops>();
    for (const row of answered) {
      const ruleId = String(row.rule_id);
      // An edit starts the rule fresh, so an older version's answer is spent.
      if (versions.get(ruleId) !== Number(row.rule_version)) continue;
      const entry = byRule.get(ruleId) ?? { rule_id: ruleId, alert_ids: [], nights: [] };
      const alertId = String(row.alert_id);
      if (!entry.alert_ids.includes(alertId)) entry.alert_ids.push(alertId);
      entry.nights.push(String(row.stay_date).slice(0, 10));
      byRule.set(ruleId, entry);
    }
    return NextResponse.json([...byRule.values()]);
  } catch (error) {
    const { status, message } = dbErrorResponse(error);
    return NextResponse.json({ error: message }, { status });
  }
}
