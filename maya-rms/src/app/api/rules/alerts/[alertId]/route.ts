/**
 * POST /api/rules/alerts/[alertId] — the owner's answer to a rule that keeps
 * adjusting the same nights.
 *
 * Two answers, both per night: keep_adjusting (the rule carries on and MAYA
 * stops asking about that night) or stop (the rule makes no more changes on
 * that night; what it already changed stays). Without `stay_dates` the answer
 * covers every night still waiting.
 *
 * Rules are a Revenue Manager's job, so the route checks that rank before it
 * calls rule_repeat_alert_choose, which checks can_manage_hotel again in the
 * database. The answer itself is recorded by the database (chosen_at,
 * chosen_by), shows in the change log, and is counted once here for product
 * analytics. The refreshed list comes back so the banner never re-asks.
 */

import { dbErrorResponse, isRealIsoDate, isUuid } from "@/lib/api-guards";
import { requireSupabaseHotelRank } from "@/lib/require-supabase-hotel";
import { createAdminClient, isAdminConfigured } from "@/utils/supabase/admin";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { MAX_ALERT_NIGHTS, loadRuleAlerts } from "../shared";

type Params = { params: Promise<{ alertId: string }> };

type Body = { choice?: unknown; stay_dates?: unknown };

export async function POST(request: Request, { params }: Params) {
  const { alertId } = await params;
  const ctx = await requireSupabaseHotelRank(await cookies(), "revenue_manager");
  if (!ctx.ok) return ctx.response;

  if (!isUuid(alertId)) {
    return NextResponse.json({ error: "Unknown alert." }, { status: 404 });
  }
  const body = (await request.json().catch(() => null)) as Body | null;
  const choice = body?.choice;
  if (choice !== "keep_adjusting" && choice !== "stop") {
    return NextResponse.json({ error: "Choose keep adjusting or stop." }, { status: 400 });
  }
  const raw = body?.stay_dates;
  let stayDates: string[] | null = null;
  if (raw !== undefined && raw !== null) {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ALERT_NIGHTS) {
      return NextResponse.json({ error: "Pick the nights to answer for." }, { status: 400 });
    }
    if (raw.some((d) => typeof d !== "string" || !isRealIsoDate(d))) {
      return NextResponse.json({ error: "That is not a real calendar date." }, { status: 400 });
    }
    stayDates = [...new Set(raw as string[])];
  }

  try {
    // The alert has to be this property's: the id comes from the browser, and
    // a wrong one must read as "not here", not as someone else's rule.
    const { data: alert, error: alertError } = await ctx.supabase
      .from("rule_repeat_alerts")
      .select("id, hotel_id, rule_id")
      .eq("id", alertId)
      .maybeSingle();
    if (alertError) throw alertError;
    if (!alert || String(alert.hotel_id) !== ctx.hotelId) {
      return NextResponse.json({ error: "Unknown alert." }, { status: 404 });
    }

    const { data: changed, error } = await ctx.supabase.rpc("rule_repeat_alert_choose", {
      p_alert_id: alertId,
      p_choice: choice,
      p_stay_dates: stayDates,
    });
    if (error) throw error;
    const nights = Array.isArray(changed) ? changed.length : 0;

    const view = await loadRuleAlerts(ctx.supabase, ctx.hotelId, true);
    await recordAnswer(ctx.supabase, {
      hotelId: ctx.hotelId,
      ruleId: String(alert.rule_id),
      choice,
      nights,
      allNights: stayDates === null,
      simulation: view.simulation,
    });
    return NextResponse.json(view);
  } catch (error) {
    const { status, message } = dbErrorResponse(error);
    return NextResponse.json({ error: message }, { status });
  }
}

/**
 * One product event per answer. Analytics never costs an owner their answer:
 * the write has already happened, so a failure here is logged and nothing
 * more (docs/analytics.md).
 */
async function recordAnswer(
  supabase: SupabaseClient,
  input: {
    hotelId: string;
    ruleId: string;
    choice: "keep_adjusting" | "stop";
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
        fn: "api/rules/alerts",
        step: "product_event",
        error: e instanceof Error ? e.message : String(e),
      }),
    );
  }
}
