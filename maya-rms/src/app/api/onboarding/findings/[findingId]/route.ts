import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import { createAdminClient, isAdminConfigured } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { classifyRoomType } from "../../../room-types/classify";
import { scheduleReprice } from "../../../room-types/reprice";

/**
 * Record the owner's answer to "is this a room?" on the type itself.
 *
 * counts_as_room, not is_active: is_active is the PMS's notion of whether the
 * type exists and is sold, and repurposing it to mean "not a bedroom" made a
 * confirmed court vanish from places that had nothing to do with room
 * counting. The flag is read everywhere the room count matters — occupancy,
 * Booking Speed, RevPAR, new rules' default sets, the simulator seed and the
 * BILLED count — which is why every change is audited, with the actor and
 * before/after, through the same helper the room-type settings PATCH uses.
 *
 * Runs on the service role after an explicit can_manage_hotel check (the
 * same gate RLS applied when this ran on the user's session), so the row can
 * carry who answered.
 *
 * Deploy order must not matter. Ahead of the migration the column is not
 * there; the confirm path then does exactly what it did before this flag
 * existed (is_active = false) and says so in the log, and the dismiss path is
 * the no-op it used to be. Never a 500 over it.
 *
 * Returns the failure to answer with, or null when the answer is recorded.
 */
async function answerRoomTypeQuestion(
  supabase: SupabaseClient,
  hotelId: string,
  actorUserId: string,
  roomTypeId: string,
  countsAsRoom: boolean,
): Promise<{ status: number; error: string } | null> {
  const { data: canManage } = await supabase.rpc("can_manage_hotel", { target_hotel_id: hotelId });
  if (!canManage) return { status: 403, error: "This needs Revenue Manager access or higher on this property." };
  if (!isAdminConfigured()) {
    return { status: 503, error: "Classifying room types needs SUPABASE_SERVICE_ROLE_KEY set on the server." };
  }
  const admin = createAdminClient();

  const outcome = await classifyRoomType(admin, {
    hotelId,
    roomTypeId,
    countsAsRoom,
    actorUserId,
    via: "onboarding_review",
  });
  switch (outcome.kind) {
    case "error":
      return { status: 500, error: outcome.message };
    case "not_found":
      // The payload named a type the hotel no longer has. Nothing changed, so
      // nothing is logged, and the finding goes back to proposed.
      return { status: 404, error: "That room type isn't on this property any more." };
    case "unchanged":
    case "confirmed":
      return null;
    case "changed": {
      // A live hotel (refresh mode) has published prices on the old
      // denominator; a hotel mid-onboarding has nothing to re-price yet.
      const { data: hotel } = await admin.from("hotels").select("is_active").eq("id", hotelId).maybeSingle();
      if (hotel?.is_active === true) scheduleReprice(admin, hotelId, "onboarding-review");
      return null;
    }
    case "pre_migration": {
      console.warn(JSON.stringify({
        fn: "answerRoomTypeQuestion",
        hotel: hotelId,
        warning: "room_types.counts_as_room is not in this database yet — run " +
          "99_supabase_migration_room_type_counts_as_room_v1.sql. " +
          (countsAsRoom
            ? "The owner's 'yes, a room' answer was not recorded."
            : "Falling back to is_active = false for this room type."),
      }));
      if (countsAsRoom) return null;
      const { error: legacyErr } = await admin
        .from("room_types")
        .update({ is_active: false })
        .eq("id", roomTypeId)
        .eq("hotel_id", hotelId);
      return legacyErr ? { status: 500, error: legacyErr.message } : null;
    }
  }
}

/**
 * Apply an accepted rule suggestion: either create the suggested rule or
 * adjust an existing rule's threshold. Runs on the user's own session so
 * RLS enforces their manage rights. Returns an error message or null.
 */
async function applyRuleSuggestion(
  supabase: SupabaseClient,
  hotelId: string,
  payload: Record<string, unknown>,
  keepRule: boolean,
): Promise<string | null> {
  if (payload.suggestion_type === "adjust_rule" && payload.rule_id) {
    const { error } = await supabase
      .from("rule_condition")
      .update({ occupancy_threshold: Number(payload.suggested_threshold) })
      .eq("rule_id", String(payload.rule_id));
    return error?.message ?? null;
  }

  if (payload.suggestion_type === "remove_rule" && payload.rule_id) {
    // The middle path on the removal card: accept that the rule shouldn't
    // keep firing, but pause it instead of deleting — same semantics as the
    // rules page's "turn it off and keep its changes". Deletion is
    // unrecoverable (the rule AND its pickup-event history go), so the
    // owner gets to choose the reversible version.
    if (keepRule) {
      const { error } = await supabase
        .from("pricing_rules")
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq("id", String(payload.rule_id))
        .eq("hotel_id", hotelId);
      return error?.message ?? null;
    }
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
 * - suspect_room_type confirm -> counts_as_room = false (audited)
 * - suspect_room_type dismiss -> counts_as_room = true, the owner says it IS one (audited)
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
    /** remove_rule confirms only: pause the rule (is_active false) instead of deleting it. */
    keepRule?: boolean;
  } | null;
  const action = body?.action;
  if (action !== "confirm" && action !== "dismiss") {
    return NextResponse.json({ error: "action must be confirm or dismiss" }, { status: 400 });
  }
  const overrideValue =
    typeof body?.value === "number" && Number.isFinite(body.value) && body.value > 0
      ? body.value
      : null;
  const keepRule = body?.keepRule === true;

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
      const failed = await answerRoomTypeQuestion(supabase, hotelId, user.id, String(payload.room_type_id), false);
      if (failed) {
        await revertClaim();
        return NextResponse.json({ error: failed.error }, { status: failed.status });
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
      const err = await applyRuleSuggestion(supabase, hotelId, payload, keepRule);
      if (err) {
        await revertClaim();
        return NextResponse.json({ error: err }, { status: 500 });
      }
    }
  }

  if (action === "dismiss" && finding.kind === "suspect_room_type" && payload.room_type_id) {
    // Dismissing the accusation is an answer too: the owner has looked at the
    // name and said people sleep there. Recording true (rather than leaving
    // null) is what stops the bill-time heuristic from excluding it anyway.
    const failed = await answerRoomTypeQuestion(supabase, hotelId, user.id, String(payload.room_type_id), true);
    if (failed) {
      await revertClaim();
      return NextResponse.json({ error: failed.error }, { status: failed.status });
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
