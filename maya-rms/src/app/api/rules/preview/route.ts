/**
 * POST /api/rules/preview: which nights a rule is about to change, for the
 * activation popup (src/components/rule-activation-dialog.tsx).
 *
 * Body: { intent: "create" | "edit" | "enable", ruleId, draft?, from?, to? }.
 * `draft` is exactly what the rule builder saves (POST /api/rules or PUT
 * /api/rules/[id]); `ruleId` is the rule's id, or for a new rule the id it
 * will be saved under. `from` and `to` ask for part of the window (the
 * popup's calendar comes in chunks); the whole window when left out.
 *
 * An import from PIE's review asks what the floors and ceilings it would
 * set change by themselves: { intent: "import_limits", limits }, the
 * `limits` POST /api/rules/import saves. Its rules need no popup (they are
 * added with Skip, which the save works out itself), so this is the only
 * thing the review shows before anything is saved.
 *
 * The answer comes from dry runs of the engine the scheduled sync runs
 * (src/lib/rule-preview.ts), never an estimate, with a fingerprint of
 * everything that could change it: the save checks it again, so the owner
 * never confirms a count the engine would not produce at that moment.
 */

import { hotelPricingHorizon } from "@/lib/pms/pricing-horizon";
import { DAYS_NOT_CALCULATED } from "@/lib/rule-activation-client";
import { enforceRateLimit } from "@/lib/rate-limit";
import { limitOverrides, parseLimits } from "@/lib/pie-import/server";
import { previewFingerprint, previewLimits, previewRule } from "@/lib/rule-preview";
import { ruleErrorResponse, ruleGate } from "@/lib/rule-route";
import { RuleSaveError, parseDraft, planRuleChange, type RuleIntent } from "@/lib/rule-save";
import { NextResponse } from "next/server";

// Minutes of headroom; a booking speed rule's preview is a few seconds.
export const maxDuration = 60;

/** The most active rules a property may have (enforce_rule_limit, 99_supabase_migration_limits_and_scale_v1.sql). */
const ACTIVE_RULE_CAP = 40;

export async function POST(req: Request) {
  const gate = await ruleGate();
  if (!gate.ok) return gate.response;
  const throttled = await enforceRateLimit(
    "rulePreview",
    `${gate.hotelId}:${gate.userId}`,
    "That's a lot of checks at once. Give it a minute and try again.",
  );
  if (throttled) return throttled;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid payload." }, { status: 400 });
  }
  const intent = body.intent;
  if (intent === "import_limits") return previewImportLimits(gate, body);
  if (intent !== "create" && intent !== "edit" && intent !== "enable") {
    return NextResponse.json({ error: "Invalid payload." }, { status: 400 });
  }

  try {
    const at = new Date().toISOString();
    const draft = intent === "enable" ? null : parseDraft((body.draft ?? {}) as Record<string, unknown>);
    const plan = await planRuleChange(gate.admin, gate.hotelId, { intent: intent as RuleIntent, ruleId: body.ruleId, draft, at });
    if (!plan.needsActivation) {
      return NextResponse.json({ needsActivation: false, change: plan.change });
    }
    if (!plan.isActive) {
      const { count } = await gate.admin
        .from("pricing_rules")
        .select("id", { count: "exact", head: true })
        .eq("hotel_id", gate.hotelId)
        .eq("is_active", true);
      if ((count ?? 0) >= ACTIVE_RULE_CAP) {
        throw new RuleSaveError(409, `This property already has ${ACTIVE_RULE_CAP} active rules, which is the maximum.`, "cap");
      }
    }
    const [horizonDays, fingerprint] = await Promise.all([
      hotelPricingHorizon(gate.admin, gate.hotelId),
      previewFingerprint(gate.admin, gate.hotelId, at),
    ]);
    const preview = await previewRule(gate.admin, {
      hotelId: gate.hotelId,
      after: plan.after,
      before: plan.stored?.is_active ? plan.stored : null,
      at,
      horizonDays,
      from: typeof body.from === "string" ? body.from : undefined,
      to: typeof body.to === "string" ? body.to : undefined,
    });
    return NextResponse.json({
      needsActivation: true,
      change: plan.change,
      versionAfter: plan.versionAfter,
      fingerprint,
      ...preview,
    });
  } catch (e) {
    return ruleErrorResponse(e, DAYS_NOT_CALCULATED);
  }
}

/** What the floors and ceilings an import from PIE would set change by themselves, for its review. */
async function previewImportLimits(gate: Extract<Awaited<ReturnType<typeof ruleGate>>, { ok: true }>, body: Record<string, unknown>) {
  try {
    const at = new Date().toISOString();
    const limits = await parseLimits(gate.admin, gate.hotelId, body.limits);
    const horizonDays = await hotelPricingHorizon(gate.admin, gate.hotelId);
    const preview = await previewLimits(gate.admin, { hotelId: gate.hotelId, limits: limitOverrides(limits) ?? {}, at, horizonDays });
    return NextResponse.json(preview);
  } catch (e) {
    return ruleErrorResponse(e, LIMITS_NOT_CALCULATED);
  }
}

/** When the days the floors and ceilings change could not be worked out. */
const LIMITS_NOT_CALCULATED = "We weren't able to work out which days the new floors and ceilings change.";
