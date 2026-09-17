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
 * Only the current version's answers count, the same as the engine. The chip
 * counts the nights still to come, because a passed night is not a night the
 * rule is doing nothing on -- it is over. "Let it run again" takes the answer
 * off every stopped night all the same, passed ones included: leaving those
 * behind would leave a change log entry saying the owner stopped the rule on
 * the handful of nights nobody took the answer off, which is not what they
 * did.
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

    // Newest night first, so a rule stopped on more nights than are read
    // keeps the ones still to come rather than filling up with old ones.
    const { data: rows, error } = await ctx.supabase
      .from("rule_repeat_alert_nights")
      .select("alert_id, rule_id, rule_version, stay_date")
      .eq("hotel_id", ctx.hotelId)
      .eq("choice", "stop")
      .order("stay_date", { ascending: false })
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
    const oldestFirst = answered
      .map((row) => ({
        alert_id: String(row.alert_id),
        rule_id: String(row.rule_id),
        rule_version: Number(row.rule_version),
        stay_date: String(row.stay_date).slice(0, 10),
      }))
      .sort((a, b) => (a.stay_date < b.stay_date ? -1 : a.stay_date > b.stay_date ? 1 : 0));
    for (const row of oldestFirst) {
      // An edit starts the rule fresh, so an older version's answer is spent.
      if (versions.get(row.rule_id) !== row.rule_version) continue;
      const entry = byRule.get(row.rule_id) ?? {
        rule_id: row.rule_id,
        alert_ids: [],
        nights: [],
        resume_nights: [],
      };
      if (!entry.alert_ids.includes(row.alert_id)) entry.alert_ids.push(row.alert_id);
      entry.resume_nights.push(row.stay_date);
      if (row.stay_date >= today) entry.nights.push(row.stay_date);
      byRule.set(row.rule_id, entry);
    }
    // A rule whose stops have all passed is not stopped on anything: no chip,
    // and nothing for the owner to take back.
    return NextResponse.json([...byRule.values()].filter((s) => s.nights.length > 0));
  } catch (error) {
    const { status, message } = dbErrorResponse(error);
    return NextResponse.json({ error: message }, { status });
  }
}
