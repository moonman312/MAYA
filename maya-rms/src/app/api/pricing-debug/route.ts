/**
 * Debug endpoint — Implementation Guide §14.
 *
 * GET /api/pricing-debug?hotel_id=...&stay_date=2026-07-14&room_type_id=abc
 *
 * Returns the most recent evaluation_audit row, current ladder_rule_state rows
 * (last_evaluated_at there is when that state last changed; last_run_at is when
 * the engine last ran for the hotel),
 * all non-retired pickup_event rows, and the last 30 days of transition/event history.
 */

import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  try {
    if (!isSupabaseConfigured()) {
      return NextResponse.json(
        { error: "Supabase is required for the debug endpoint." },
        { status: 501 },
      );
    }

    const supabase = createClient(await cookies());
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const hotelId = searchParams.get("hotel_id");
    const stayDate = searchParams.get("stay_date");
    const roomTypeId = searchParams.get("room_type_id");

    if (!hotelId || !stayDate || !roomTypeId) {
      return NextResponse.json(
        { error: "hotel_id, stay_date, and room_type_id are required." },
        { status: 400 },
      );
    }

    // Latest evaluation audit.
    const { data: audit } = await supabase
      .from("evaluation_audit")
      .select("*")
      .eq("hotel_id", hotelId)
      .eq("stay_date", stayDate)
      .eq("room_type_id", roomTypeId)
      .order("evaluated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // Current ladder rule states. ladder_rule_state has no hotel column, so
    // the read is narrowed to this hotel's rules: its primary key starts with
    // rule_id, and without it the lookup scanned every hotel's state.
    const { data: hotelRules } = await supabase
      .from("pricing_rules")
      .select("id")
      .eq("hotel_id", hotelId);
    const ruleIds = (hotelRules ?? []).map((r) => String(r.id));
    const { data: ladderStates } =
      ruleIds.length === 0
        ? { data: [] }
        : await supabase
            .from("ladder_rule_state")
            .select("*")
            .in("rule_id", ruleIds)
            .eq("stay_date", stayDate)
            .eq("room_type_id", roomTypeId);

    // When the engine last ran for this hotel. A ladder state row's
    // last_evaluated_at only moves when that state changes, so this is the
    // answer to "was it checked recently".
    const { data: lastRun } = await supabase
      .from("evaluation_run_log")
      .select("evaluated_at")
      .eq("hotel_id", hotelId)
      .order("evaluated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // The fires still adjusting this cell, in the order they apply. A rule
    // can hold several: each is one time it fired here (pickup_event.fire_seq).
    const { data: pickupEvents } = await supabase
      .from("pickup_event")
      .select("*")
      .eq("hotel_id", hotelId)
      .eq("stay_date", stayDate)
      .eq("affected_room_type_id", roomTypeId)
      .is("retired_at", null)
      .order("applied_at", { ascending: true })
      .order("fire_seq", { ascending: true });

    // 30-day ladder transition history.
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const { data: ladderHistory } = await supabase
      .from("ladder_transition_event")
      .select("*")
      .eq("hotel_id", hotelId)
      .eq("stay_date", stayDate)
      .eq("room_type_id", roomTypeId)
      .gte("transitioned_at", thirtyDaysAgo.toISOString())
      .order("transitioned_at", { ascending: false });

    // 30-day pickup event history (including retired).
    const { data: pickupHistory } = await supabase
      .from("pickup_event")
      .select("*")
      .eq("hotel_id", hotelId)
      .eq("stay_date", stayDate)
      .eq("affected_room_type_id", roomTypeId)
      .gte("applied_at", thirtyDaysAgo.toISOString())
      .order("applied_at", { ascending: false })
      .order("fire_seq", { ascending: false });

    // Current published price.
    const { data: publishedPrice } = await supabase
      .from("published_price")
      .select("*")
      .eq("hotel_id", hotelId)
      .eq("stay_date", stayDate)
      .eq("room_type_id", roomTypeId)
      .maybeSingle();

    return NextResponse.json({
      audit,
      ladder_states: ladderStates ?? [],
      last_run_at: lastRun?.evaluated_at ?? null,
      active_pickup_events: pickupEvents ?? [],
      ladder_transition_history: ladderHistory ?? [],
      pickup_event_history: pickupHistory ?? [],
      published_price: publishedPrice,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Debug query failed." },
      { status: 500 },
    );
  }
}
