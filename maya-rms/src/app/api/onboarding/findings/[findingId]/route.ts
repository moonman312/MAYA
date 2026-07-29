import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

/**
 * Apply an accepted rule suggestion: either create the suggested rule or
 * adjust an existing rule's threshold. Runs on the user's own session so
 * RLS enforces their manage rights. Returns an error message or null.
 */
async function applyRuleSuggestion(
  supabase: SupabaseClient,
  hotelId: string,
  payload: Record<string, unknown>,
): Promise<string | null> {
  if (payload.suggestion_type === "adjust_rule" && payload.rule_id) {
    const { error } = await supabase
      .from("rule_condition")
      .update({ occupancy_threshold: Number(payload.suggested_threshold) })
      .eq("rule_id", String(payload.rule_id));
    return error?.message ?? null;
  }

  if (payload.suggestion_type === "remove_rule" && payload.rule_id) {
    // Same deletion the rules page performs. pickup_event rows go first —
    // that FK has no cascade — then the rule; the cascade takes the
    // condition row and room-type joins. The hotel filter keeps a stale
    // suggestion from ever reaching across hotels.
    const { error: eventErr } = await supabase
      .from("pickup_event")
      .delete()
      .eq("rule_id", String(payload.rule_id))
      .eq("hotel_id", hotelId);
    if (eventErr) return eventErr.message;
    const { error } = await supabase
      .from("pricing_rules")
      .delete()
      .eq("id", String(payload.rule_id))
      .eq("hotel_id", hotelId);
    return error?.message ?? null;
  }

  if (payload.suggestion_type === "add_rule" && payload.spec) {
    const spec = payload.spec as {
      name: string;
      priority: number;
      condition: Record<string, unknown>;
      action: { action_type: string; action_direction: string; action_value: number };
      is_pickup_rule: boolean;
    };
    const { data: ruleRow, error: insErr } = await supabase
      .from("pricing_rules")
      .insert({
        hotel_id: hotelId,
        name: spec.name,
        priority: spec.priority,
        is_active: true,
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
    if (insErr || !ruleRow) return insErr?.message ?? "rule insert failed";
    const ruleId = String(ruleRow.id);

    // No transaction spans these inserts, so a failure partway through would
    // otherwise leave an active rule with no condition row — which the
    // engine treats as always-matching. Delete the orphaned rule (cascades
    // to whichever of condition/room-type joins already landed) instead of
    // returning with it still live.
    const { error: condErr } = await supabase
      .from("rule_condition")
      .insert({ rule_id: ruleId, ...spec.condition });
    if (condErr) {
      await supabase.from("pricing_rules").delete().eq("id", ruleId);
      return condErr.message;
    }

    const roomTypeIds = Array.isArray(payload.room_type_ids)
      ? (payload.room_type_ids as string[])
      : [];
    if (roomTypeIds.length > 0) {
      const joins = roomTypeIds.map((rtId) => ({ rule_id: ruleId, room_type_id: rtId }));
      const { error: sigErr } = await supabase.from("rule_signal_room_type").insert(joins);
      if (sigErr) {
        await supabase.from("pricing_rules").delete().eq("id", ruleId);
        return sigErr.message;
      }
      const { error: affErr } = await supabase.from("rule_affected_room_type").insert(joins);
      if (affErr) {
        await supabase.from("pricing_rules").delete().eq("id", ruleId);
        return affErr.message;
      }
    }
    return null;
  }

  return "Unrecognized suggestion payload";
}

/**
 * Confirm or dismiss a finding, applying its side effect:
 * - closed_period confirm  -> insert hotel_closed_periods
 * - suspect_room_type confirm -> deactivate the room type
 * - duplicate_room_type dismiss -> reactivate (it was auto-deactivated)
 * - everything else: status change only
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ findingId: string }> },
) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
  }
  const supabase = createClient(await cookies());
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const hotelId = await resolveAccessibleHotelId(supabase);
  if (!hotelId) {
    return NextResponse.json({ error: "No hotel" }, { status: 400 });
  }

  const { findingId } = await params;
  const body = (await request.json().catch(() => null)) as {
    action?: string;
    /** Owner's own number for value-bearing recommendations (guardrails): accept as-is, pad it, or replace it. */
    value?: number;
  } | null;
  const action = body?.action;
  if (action !== "confirm" && action !== "dismiss") {
    return NextResponse.json({ error: "action must be confirm or dismiss" }, { status: 400 });
  }
  const overrideValue =
    typeof body?.value === "number" && Number.isFinite(body.value) && body.value > 0
      ? body.value
      : null;

  const { data: finding } = await supabase
    .from("onboarding_findings")
    .select("id, kind, status, payload")
    .eq("id", findingId)
    .eq("hotel_id", hotelId)
    .maybeSingle();
  if (!finding) {
    return NextResponse.json({ error: "Finding not found" }, { status: 404 });
  }

  const originalStatus = String(finding.status);
  const newStatus = action === "confirm" ? "confirmed" : "dismissed";

  // Claim the finding before any side effect runs. None of the side effects
  // below are safe to repeat — a second confirm inserts a second pricing
  // rule or a second closed period — so a finding already resolved by an
  // earlier request (a retry, a double-click past the busy guard, two open
  // tabs) must stop here rather than re-apply.
  const { data: claimed, error: claimErr } = await supabase
    .from("onboarding_findings")
    .update({ status: newStatus, resolved_by: user.id, resolved_at: new Date().toISOString() })
    .eq("id", findingId)
    .eq("hotel_id", hotelId)
    .in("status", ["proposed", "auto_applied"])
    .select("id")
    .maybeSingle();
  if (claimErr) {
    return NextResponse.json({ error: claimErr.message }, { status: 500 });
  }
  if (!claimed) {
    return NextResponse.json({ error: "Finding was already resolved" }, { status: 409 });
  }

  // If a side effect fails after the claim, put status back the way it was
  // so a genuine retry (not a duplicate click) can still claim and apply it.
  const revertClaim = async () => {
    await supabase
      .from("onboarding_findings")
      .update({ status: originalStatus, resolved_by: null, resolved_at: null })
      .eq("id", findingId);
  };

  const payload = (finding.payload ?? {}) as Record<string, unknown>;

  if (action === "confirm") {
    if (finding.kind === "closed_period") {
      // Seasonal findings carry every observed instance; one-offs carry one.
      const periods = Array.isArray(payload.periods)
        ? (payload.periods as Array<{ start_date: string; end_date: string }>)
        : payload.start_date && payload.end_date
          ? [{ start_date: String(payload.start_date), end_date: String(payload.end_date) }]
          : [];
      if (periods.length > 0) {
        const { error } = await supabase.from("hotel_closed_periods").insert(
          periods.map((p) => ({
            hotel_id: hotelId,
            room_type_id: null,
            start_date: p.start_date,
            end_date: p.end_date,
            source: "onboarding",
          })),
        );
        if (error) {
          await revertClaim();
          return NextResponse.json({ error: error.message }, { status: 500 });
        }
      }
    }
    if (finding.kind === "suspect_room_type" && payload.room_type_id) {
      const { error } = await supabase
        .from("room_types")
        .update({ is_active: false })
        .eq("id", String(payload.room_type_id))
        .eq("hotel_id", hotelId);
      if (error) {
        await revertClaim();
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
    }
    // Refresh-mode duplicate: the deactivation was only proposed — apply now.
    if (
      finding.kind === "duplicate_room_type" &&
      originalStatus === "proposed" &&
      payload.deactivate_room_type_id
    ) {
      const { error } = await supabase
        .from("room_types")
        .update({ is_active: false })
        .eq("id", String(payload.deactivate_room_type_id))
        .eq("hotel_id", hotelId);
      if (error) {
        await revertClaim();
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
    }
    if (finding.kind === "guardrail_suggestion" && payload.room_type_id && payload.field) {
      const field = String(payload.field);
      if (field !== "floor_price" && field !== "ceiling_price") {
        await revertClaim();
        return NextResponse.json({ error: "Bad guardrail field" }, { status: 400 });
      }
      // The owner's own number wins over the suggestion when they typed one
      // (the DB check still guards floor <= ceiling and surfaces as an error).
      const { error } = await supabase
        .from("room_types")
        .update({ [field]: overrideValue ?? Number(payload.suggested) })
        .eq("id", String(payload.room_type_id))
        .eq("hotel_id", hotelId);
      if (error) {
        await revertClaim();
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
    }
    if (finding.kind === "rule_suggestion") {
      const err = await applyRuleSuggestion(supabase, hotelId, payload);
      if (err) {
        await revertClaim();
        return NextResponse.json({ error: err }, { status: 500 });
      }
    }
  }

  if (
    action === "dismiss" &&
    finding.kind === "duplicate_room_type" &&
    originalStatus === "auto_applied" &&
    payload.deactivate_room_type_id
  ) {
    // Undo the auto-fix: bring the room type back.
    const { error } = await supabase
      .from("room_types")
      .update({ is_active: true })
      .eq("id", String(payload.deactivate_room_type_id))
      .eq("hotel_id", hotelId);
    if (error) {
      await revertClaim();
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true });
}
