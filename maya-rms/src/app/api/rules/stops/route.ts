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
 *
 * POST /api/rules/stops — that "Let it run again": one rule's stopped nights,
 * across every alert they were filed under, in one call to
 * rule_repeat_alert_resume_many. One click is one thing the owner did, so it
 * is one instant on every night in the change log and one product event, not
 * one per alert. Rules are a Revenue Manager's job, so the route checks that
 * rank first, and the function checks can_manage_hotel again in the database.
 * The chip's list comes back fresh.
 */

import { dbErrorResponse, isRealIsoDate, isUuid } from "@/lib/api-guards";
import { isMissingRelationError } from "@/lib/engine/snapshots";
import { requireSupabaseHotel, requireSupabaseHotelRank } from "@/lib/require-supabase-hotel";
import type { RuleStops } from "@/lib/rule-alerts";
import { hotelToday } from "@/lib/simulator";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { recordAlertAnswer } from "../alerts/shared";

/** Stopped nights read at once. A rule stopped on more than this is a story in itself. */
export const MAX_STOPPED_NIGHTS = 400;

/** Every stopped night of the hotel's rules that the chip covers, grouped by rule. */
async function loadRuleStops(supabase: SupabaseClient, hotelId: string): Promise<RuleStops[]> {
  const { data: hotel } = await supabase.from("hotels").select("timezone").eq("id", hotelId).maybeSingle();
  const today = hotelToday(String(hotel?.timezone ?? "UTC"));

  // Newest night first, so a rule stopped on more nights than are read
  // keeps the ones still to come rather than filling up with old ones.
  const { data: rows, error } = await supabase
    .from("rule_repeat_alert_nights")
    .select("alert_id, rule_id, rule_version, stay_date")
    .eq("hotel_id", hotelId)
    .eq("choice", "stop")
    .order("stay_date", { ascending: false })
    .limit(MAX_STOPPED_NIGHTS);
  if (error) {
    // A database without the alert tables yet has nothing to show, which is
    // not an error the rules page should carry.
    if (isMissingRelationError(error)) return [];
    throw error;
  }
  const answered = (rows ?? []) as Record<string, unknown>[];
  if (answered.length === 0) return [];

  const { data: rules } = await supabase
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
  return [...byRule.values()].filter((s) => s.nights.length > 0);
}

export async function GET() {
  const ctx = await requireSupabaseHotel(await cookies());
  if (!ctx.ok) return ctx.response;

  try {
    return NextResponse.json(await loadRuleStops(ctx.supabase, ctx.hotelId));
  } catch (error) {
    const { status, message } = dbErrorResponse(error);
    return NextResponse.json({ error: message }, { status });
  }
}

type ResumeBody = { alert_ids?: unknown; stay_dates?: unknown };

export async function POST(request: Request) {
  const ctx = await requireSupabaseHotelRank(await cookies(), "revenue_manager");
  if (!ctx.ok) return ctx.response;

  const body = (await request.json().catch(() => null)) as ResumeBody | null;
  const rawIds = body?.alert_ids;
  const rawDates = body?.stay_dates;
  if (
    !Array.isArray(rawIds) ||
    rawIds.length === 0 ||
    rawIds.length > MAX_STOPPED_NIGHTS ||
    rawIds.some((id) => typeof id !== "string" || !isUuid(id))
  ) {
    return NextResponse.json({ error: "Pick the rule to let run again." }, { status: 400 });
  }
  if (!Array.isArray(rawDates) || rawDates.length === 0 || rawDates.length > MAX_STOPPED_NIGHTS) {
    return NextResponse.json({ error: "Pick the nights to let it run on." }, { status: 400 });
  }
  if (rawDates.some((d) => typeof d !== "string" || !isRealIsoDate(d))) {
    return NextResponse.json({ error: "That is not a real calendar date." }, { status: 400 });
  }
  const alertIds = [...new Set(rawIds as string[])];
  const stayDates = [...new Set(rawDates as string[])];

  try {
    // Every alert has to be this property's and one rule's: the ids come from
    // the browser, and a wrong one must read as "not here", not as someone
    // else's rule.
    const { data: alerts, error: alertsError } = await ctx.supabase
      .from("rule_repeat_alerts")
      .select("id, hotel_id, rule_id")
      .in("id", alertIds);
    if (alertsError) throw alertsError;
    const found = (alerts ?? []) as Record<string, unknown>[];
    if (found.length !== alertIds.length || found.some((a) => String(a.hotel_id) !== ctx.hotelId)) {
      return NextResponse.json({ error: "Unknown alert." }, { status: 404 });
    }
    const ruleIds = [...new Set(found.map((a) => String(a.rule_id)))];
    if (ruleIds.length !== 1) {
      return NextResponse.json({ error: "Let one rule run again at a time." }, { status: 400 });
    }

    const { data: changed, error } = await ctx.supabase.rpc("rule_repeat_alert_resume_many", {
      p_alert_ids: alertIds,
      p_stay_dates: stayDates,
    });
    if (error) throw error;

    const { data: settings } = await ctx.supabase
      .from("hotel_settings")
      .select("simulation_mode")
      .eq("hotel_id", ctx.hotelId)
      .maybeSingle();
    await recordAlertAnswer(ctx.supabase, {
      route: "api/rules/stops",
      hotelId: ctx.hotelId,
      ruleId: ruleIds[0],
      choice: "resume",
      nights: Array.isArray(changed) ? changed.length : 0,
      allNights: false,
      simulation: settings?.simulation_mode !== false,
    });
    return NextResponse.json(await loadRuleStops(ctx.supabase, ctx.hotelId));
  } catch (error) {
    const { status, message } = dbErrorResponse(error);
    return NextResponse.json({ error: message }, { status });
  }
}
