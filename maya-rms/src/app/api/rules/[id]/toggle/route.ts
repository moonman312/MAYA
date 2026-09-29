import { ruleErrorResponse, ruleGate, saveThroughPopup } from "@/lib/rule-route";
import { RuleSaveError, planRuleChange } from "@/lib/rule-save";
import { toggleRule } from "@/lib/rules-store";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { NextResponse } from "next/server";

type Params = { params: Promise<{ id: string }> };

/**
 * The rules list's switch. Body: { on: false } switches a rule off at once
 * (its changes stay on the price, frozen, until it is switched on again).
 * { on: true } switches it on, and needs the owner's choice from the
 * activation popup: { on: true, activation: "apply" | "skip", fingerprint,
 * touched } (see src/lib/rule-route.ts). No body flips the rule: off when it
 * is on, and refused (409, activation_required) when it is off, since
 * nothing may switch a rule on around the popup.
 */
export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const body = ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>;

  if (!isSupabaseConfigured()) {
    // Demo mode: the in-memory rules, no prices to preview.
    const ok = await toggleRule(id);
    return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Rule not found." }, { status: 404 });
  }

  const gate = await ruleGate();
  if (!gate.ok) return gate.response;
  try {
    const { data: rule, error } = await gate.admin
      .from("pricing_rules")
      .select("id, is_active")
      .eq("id", id)
      .eq("hotel_id", gate.hotelId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!rule) return NextResponse.json({ error: "Rule not found." }, { status: 404 });

    const on = typeof body.on === "boolean" ? body.on : !rule.is_active;
    if (!on) {
      if (!rule.is_active) return NextResponse.json({ ok: true, enabled: false });
      const { data: saved, error: offError } = await gate.supabase
        .from("pricing_rules")
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq("id", id)
        .select("id");
      if (offError) throw new Error(offError.message);
      if ((saved ?? []).length === 0) throw new RuleSaveError(403, "Only a Revenue Manager or above can change this.", "forbidden");
      return NextResponse.json({ ok: true, enabled: false });
    }
    if (rule.is_active) return NextResponse.json({ ok: true, enabled: true });

    const plan = await planRuleChange(gate.admin, gate.hotelId, { intent: "enable", ruleId: id, at: new Date().toISOString() });
    const { result, choice } = await saveThroughPopup(gate, plan, body, "switch");
    return NextResponse.json({ ok: true, enabled: result.is_active, skipped: choice === "skip" });
  } catch (e) {
    return ruleErrorResponse(e, "Failed to switch the rule.");
  }
}
