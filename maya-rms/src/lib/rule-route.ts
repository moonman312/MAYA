/**
 * What the rule routes share: who may change rules, and the save through the
 * activation popup (Apply or Skip), checked against the numbers the popup
 * showed.
 */

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import { hotelPricingHorizon } from "@/lib/pms/pricing-horizon";
import { nudgeHotelSync } from "@/lib/pms/sync-nudge";
import { RULE_CHANGE_FORBIDDEN } from "@/lib/rule-form";
import { previewFingerprint } from "@/lib/rule-preview";
import {
  DAYS_CHANGED,
  RuleSaveError,
  cleanTouched,
  commitRuleChange,
  type ActivationChoice,
  type CommitResult,
  type RulePlan,
} from "@/lib/rule-save";
import { createAdminClient, isAdminConfigured } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";

export type RuleGate =
  | { ok: true; supabase: SupabaseClient; admin: SupabaseClient; hotelId: string; userId: string }
  | { ok: false; response: NextResponse };

/**
 * Signed in, a property picked, Revenue Manager or above on it, and the
 * server able to read the engine's tables (the preview's dry runs and the
 * Skip's marks need the service role, as the manual price route does). In
 * that order, so a viewer learns nothing about the server's set-up.
 */
export async function ruleGate(): Promise<RuleGate> {
  if (!isSupabaseConfigured()) {
    return { ok: false, response: NextResponse.json({ error: "Supabase required for rule changes." }, { status: 501 }) };
  }
  const supabase = createClient(await cookies());
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const hotelId = await resolveAccessibleHotelId(supabase);
  if (!hotelId) return { ok: false, response: NextResponse.json({ error: "Pick a property first." }, { status: 400 }) };
  const { data: canManage } = await supabase.rpc("can_manage_hotel", { target_hotel_id: hotelId });
  if (!canManage) {
    return { ok: false, response: NextResponse.json({ error: RULE_CHANGE_FORBIDDEN, code: "forbidden" }, { status: 403 }) };
  }
  if (!isAdminConfigured()) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Rule changes need SUPABASE_SERVICE_ROLE_KEY set on the server." }, { status: 503 }),
    };
  }
  return { ok: true, supabase, admin: createAdminClient(), hotelId, userId: user.id };
}

/** A refused save or preview as a response. */
export function ruleErrorResponse(e: unknown, fallback: string): NextResponse {
  if (e instanceof RuleSaveError) {
    return NextResponse.json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, { status: e.status });
  }
  console.error(JSON.stringify({ fn: "rule-route", error: e instanceof Error ? e.message : String(e) }));
  return NextResponse.json({ error: fallback }, { status: 500 });
}

export type ActivationBody = {
  activation?: unknown;
  fingerprint?: unknown;
  touched?: unknown;
  /** How many days the popup showed, for the analytics event. */
  days?: unknown;
  /** Whether the popup had to work the days out again before this click. */
  refreshed?: unknown;
};

/**
 * Save a plan, through the popup where it needs one: the owner's Apply or
 * Skip. Apply is saved only on the numbers the popup showed: when anything
 * that could change them moved since (previewFingerprint), nothing is saved
 * and the answer is 409 "stale", and the popup works the days out again and
 * saves at once if they are the same, or shows the new ones. Skip moves no
 * price whatever the days are (its marks are worked out here, at the save),
 * so it needs no check, and the popup offers it even when the days could
 * not be worked out.
 */
export async function saveThroughPopup(
  gate: Extract<RuleGate, { ok: true }>,
  plan: RulePlan,
  body: ActivationBody,
  from: "switch" | "builder_new" | "builder_edit" | "suggestion",
): Promise<{ result: CommitResult; choice: ActivationChoice | null }> {
  const at = new Date().toISOString();
  let choice: ActivationChoice | null = null;
  if (plan.needsActivation) {
    if (body.activation !== "apply" && body.activation !== "skip") {
      throw new RuleSaveError(409, "Choose whether to apply the price adjustments.", "activation_required");
    }
    choice = body.activation;
    if (choice === "apply") {
      const now = await previewFingerprint(gate.admin, gate.hotelId, at);
      if (typeof body.fingerprint !== "string" || body.fingerprint !== now) {
        throw new RuleSaveError(409, DAYS_CHANGED, "stale");
      }
    }
  }
  const horizonDays = await hotelPricingHorizon(gate.admin, gate.hotelId);
  const result = await commitRuleChange(gate.supabase, gate.admin, plan, choice, {
    at,
    horizonDays,
    touched: cleanTouched(body.touched),
  });
  if (plan.needsActivation || plan.change === "behaviour" || plan.change === "undo") {
    await nudgeHotelSync(gate.admin, gate.hotelId).catch(() => "next_cycle");
  }
  if (choice) {
    const days = Number(body.days);
    const { error } = await gate.admin.rpc("product_event_emit", {
      p_event: "rule.activation_chosen",
      p_hotel_id: gate.hotelId,
      p_user_id: gate.userId,
      p_properties: {
        rule_id: plan.ruleId,
        choice,
        from,
        kind: plan.after.is_pickup_rule ? "event" : "standard",
        days: Number.isFinite(days) && days >= 0 ? Math.min(Math.floor(days), 1000) : null,
        refreshed: body.refreshed === true,
      },
      p_source: "app",
    });
    if (error) console.error(JSON.stringify({ fn: "rule-route", step: "activation_event", error: error.message }));
  }
  return { result, choice };
}
