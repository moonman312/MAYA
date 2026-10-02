/**
 * POST /api/rules/import: create the rules (and set the floors and
 * ceilings) an import from PIE read, after the owner's review.
 *
 * Body: { rules: [{ id, on, ...the rule builder's draft }], limits:
 * [{ roomTypeId, floor, ceiling }] }.
 *
 * Who may: whoever may create rules (ruleGate: Revenue Manager or above).
 *
 * PIE has already changed the rates in Cloudbeds on the nights its rules
 * match today, so applying the same rules in MAYA there would change those
 * nights twice. The rules that were on in PIE are therefore added on with
 * Skip, never Apply, and with no popup (Jake, 2026-10-01): the nights they
 * would change right now keep their prices, each until its rule stops
 * being true there and then becomes true again, and every other night
 * works as Apply. Those nights are the ones the activation popup would
 * have shown, worked out here at the save itself, on the limits being set
 * (previewRuleSet, then skipPlanForRules, as the popup's Skip), so there is
 * no preview to go stale before the save. When they can't be worked out,
 * every night each rule could act on is held, as the popup's Skip does
 * then. Rules that were off in PIE are created off. An activation,
 * fingerprint or days sent by a page from before this change are ignored.
 *
 * Nothing is saved when the rules on would go past the 40-rule cap. The
 * held nights are worked out first, then the limits are set, then each rule
 * is created in the screenshot's order; a rule that fails is named in the
 * answer and the rest still save. When every rule fails after the limits
 * were set, the answer is still a success that says the limits were set
 * and names each rule that couldn't be added.
 *
 * Nothing from the screenshot reaches the server but the rules and limits
 * themselves: no image, no text read from it.
 */

import { checkCap, limitOverrides, planImportRequest, type ImportRequest } from "@/lib/pie-import/server";
import { enforceRateLimit } from "@/lib/rate-limit";
import { hotelPricingHorizon } from "@/lib/pms/pricing-horizon";
import { nudgeHotelSync } from "@/lib/pms/sync-nudge";
import { previewRuleSet, skipPlanForRules, type SkipPlan } from "@/lib/rule-preview";
import { ruleErrorResponse, ruleGate } from "@/lib/rule-route";
import { RuleSaveError, cleanTouched, commitRuleChange } from "@/lib/rule-save";
import { NextResponse } from "next/server";

export const maxDuration = 120;

export async function POST(req: Request) {
  const gate = await ruleGate();
  if (!gate.ok) return gate.response;
  const throttled = await enforceRateLimit("ruleImport", `${gate.hotelId}:${gate.userId}`, "That's a lot of imports at once. Give it a minute and try again.");
  if (throttled) return throttled;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid payload." }, { status: 400 });
  }

  try {
    const at = new Date().toISOString();
    const request = await planImportRequest(gate.admin, gate.hotelId, body, at);
    // Rules an earlier try already created stay as they are.
    const on = request.rules.flatMap((r) => (r.on && !r.existing ? [r.plan] : []));
    await checkCap(gate.admin, gate.hotelId, on.length);
    const horizonDays = await hotelPricingHorizon(gate.admin, gate.hotelId);

    // The Skip for all of them: the nights they would change right now, on
    // the limits being set, held for every one.
    let held: string[] | "all" = [];
    let touched: string[] = [];
    let skipPlans = new Map<string, SkipPlan>();
    if (on.length > 0) {
      const input = { hotelId: gate.hotelId, rules: on.map((plan) => plan.after), limits: limitOverrides(request.limits), at, horizonDays };
      try {
        const days = await previewRuleSet(gate.admin, input);
        held = days.affected;
        touched = cleanTouched(days.touched);
      } catch (e) {
        console.error(JSON.stringify({ fn: "rules-import", step: "days", error: e instanceof Error ? e.message : String(e) }));
        held = "all";
      }
      skipPlans = await skipPlanForRules(gate.admin, input, held);
    }

    const limitsSet = await setLimits(gate, request);
    if (limitsSet.error) {
      return NextResponse.json({ error: limitsSet.error, created: [], failed: [], limits: limitsSet.count }, { status: 500 });
    }

    const created: { id: string; on: boolean }[] = [];
    const failed: { id: string; error: string }[] = [];
    for (const [i, rule] of request.rules.entries()) {
      if (rule.existing) {
        created.push({ id: rule.id, on: rule.on });
        continue;
      }
      try {
        const result = await commitRuleChange(gate.supabase, gate.admin, rule.plan, rule.on ? "skip" : null, {
          at,
          horizonDays,
          touched: rule.on ? touched : [],
          held,
          ...(rule.on ? { skipPlan: skipPlans.get(rule.id) } : { off: true }),
        });
        created.push({ id: result.id, on: result.is_active });
      } catch (e) {
        // Created a moment ago by another try of the same import.
        if (e instanceof RuleSaveError && e.code === "rule_exists") {
          created.push({ id: rule.id, on: rule.on });
          continue;
        }
        failed.push({ id: rule.id, error: e instanceof RuleSaveError ? e.message : "Could not save the rule. Try again in a moment." });
        // Past the cap now (another tab switched one on): the rest that are on would fail too.
        if (e instanceof RuleSaveError && e.code === "refused" && /active rules/i.test(e.message)) {
          for (const rest of request.rules.slice(i + 1)) if (!rest.existing) failed.push({ id: rest.id, error: e.message });
          break;
        }
      }
    }

    if (created.length > 0 || limitsSet.count > 0) await nudgeHotelSync(gate.admin, gate.hotelId).catch(() => "next_cycle");
    const skipped = on.length > 0;
    const { error } = await gate.admin.rpc("product_event_emit", {
      p_event: "rules.imported",
      p_hotel_id: gate.hotelId,
      p_user_id: gate.userId,
      p_properties: {
        from: "pie",
        created: created.length,
        created_on: created.filter((c) => c.on).length,
        created_off: created.filter((c) => !c.on).length,
        failed: failed.length,
        limits: limitsSet.count,
        choice: skipped ? "skip" : "none",
        held_all: held === "all",
        // The nights held, as worked out at the save; null when they couldn't be, or no rule was on.
        days: skipped && held !== "all" ? Math.min(held.length, 1000) : null,
      },
      p_source: "app",
    });
    if (error) console.error(JSON.stringify({ fn: "rules-import", step: "event", error: error.message }));
    // Nothing changed at all: the first rule's reason. When the limits were
    // set, the answer says so, with each rule that couldn't be added.
    const none = failed.length > 0 && created.length === 0 && limitsSet.count === 0;
    return NextResponse.json(
      { created, failed, limits: limitsSet.count, skipped, ...(none ? { error: failed[0].error } : {}) },
      { status: none ? 409 : 200 },
    );
  } catch (e) {
    return ruleErrorResponse(e, "Could not create the rules. Try again in a moment.");
  }
}

/**
 * The floors and ceilings, under the owner's own session (RLS: Revenue
 * Manager or above, recorded in God Mode the way any change of theirs is).
 * Floor and ceiling go in one update, so the database's floor-under-ceiling
 * check sees the pair.
 */
async function setLimits(
  gate: Extract<Awaited<ReturnType<typeof ruleGate>>, { ok: true }>,
  request: ImportRequest,
): Promise<{ count: number; error: string | null }> {
  let count = 0;
  for (const l of request.limits) {
    const { data, error } = await gate.supabase
      .from("room_types")
      .update({ floor_price: l.floor, ceiling_price: l.ceiling })
      .eq("id", l.roomTypeId)
      .eq("hotel_id", gate.hotelId)
      .select("id");
    if (error || (data ?? []).length === 0) {
      console.error(JSON.stringify({ fn: "rules-import", step: "limits", roomTypeId: l.roomTypeId, error: error?.message ?? "no row" }));
      return { count, error: "The floors and ceilings couldn't all be set, so no rules were created. Try again." };
    }
    count++;
  }
  return { count, error: null };
}
