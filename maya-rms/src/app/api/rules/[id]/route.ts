import { hasHotelRank } from "@/lib/require-supabase-hotel";
import {
  RULE_CHANGE_FORBIDDEN,
  RoomTypeSetError,
  RuleAmountError,
  roomTypeIdListError,
  ruleActionError,
  undoOnCancellationError,
} from "@/lib/rule-form";
import { ruleErrorResponse, ruleGate, saveThroughPopup } from "@/lib/rule-route";
import { RULE_CHANGED_ELSEWHERE, RuleSaveError, parseDraft, planRuleChange } from "@/lib/rule-save";
import { deleteRule, updateRule } from "@/lib/rules-store";
import type { UpdateRuleInput } from "@/lib/rules-store";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

type Params = { params: Promise<{ id: string }> };

/**
 * The fields that change what a rule does to prices (the undo box included,
 * and priority, which decides which booking speed or pickup change is the
 * stronger).
 */
const MOVES_PRICES: (keyof UpdateRuleInput)[] = [
  "priority",
  "action",
  "condition",
  "signal_room_type_ids",
  "affected_room_type_ids",
  "start_date",
  "end_date",
  "is_annual",
  "dow_mask",
  "undo_on_cancellation",
];

/**
 * The rule builder's Save changes: the whole rule as the form holds it
 * (rule_name, condition, action, both room type lists, the undo box), with
 * `expected_version`, the version the form was filled from. An edit to a
 * rule that is on and can move a price goes through the activation popup
 * (the owner's Apply or Skip, src/lib/rule-route.ts); a new name, or an edit
 * to a rule that is off, saves at once and moves no price.
 *
 * A body that is not the whole rule is the older partial update. It may not
 * change what a rule that is on does to prices, nor switch a rule on: both
 * go through the popup.
 */
export async function PUT(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const supabase = isSupabaseConfigured() ? createClient(await cookies()) : undefined;
    if (!supabase) {
      return NextResponse.json({ error: "Supabase required for rule updates." }, { status: 501 });
    }

    const body = (await req.json()) as Partial<UpdateRuleInput> & Record<string, unknown>;
    if (typeof body.rule_name === "string" && body.condition && body.action) {
      return await saveBuilderEdit(id, body);
    }

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const setError =
      ruleActionError(body.action) ??
      roomTypeIdListError(body.signal_room_type_ids, "measure") ??
      roomTypeIdListError(body.affected_room_type_ids, "change") ??
      undoOnCancellationError(body.undo_on_cancellation);
    if (setError) {
      return NextResponse.json({ error: setError }, { status: 400 });
    }
    const { data: current } = await supabase.from("pricing_rules").select("hotel_id, is_active").eq("id", id).maybeSingle();
    const movesPrices = MOVES_PRICES.some((k) => body[k] !== undefined);
    if ((current?.is_active === true && movesPrices) || (current?.is_active === false && body.is_active === true)) {
      return NextResponse.json(
        { error: "Choose whether to apply the price adjustments.", code: "activation_required" },
        { status: 409 },
      );
    }
    const ok = await updateRule(id, body, supabase);
    if (!ok) {
      // A rule the caller can read but whose hotel they can't manage (staff,
      // viewers): row security left it as it was. Say why.
      const { data: rule } = await supabase.from("pricing_rules").select("hotel_id").eq("id", id).maybeSingle();
      if (rule?.hotel_id && !(await hasHotelRank(supabase, String(rule.hotel_id), "revenue_manager"))) {
        return NextResponse.json({ error: RULE_CHANGE_FORBIDDEN }, { status: 403 });
      }
      return NextResponse.json({ error: "Rule not found or update failed." }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof RoomTypeSetError || error instanceof RuleAmountError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update rule." },
      { status: 500 },
    );
  }
}

async function saveBuilderEdit(id: string, body: Record<string, unknown>) {
  const gate = await ruleGate();
  if (!gate.ok) return gate.response;
  try {
    const draft = parseDraft(body);
    const plan = await planRuleChange(gate.admin, gate.hotelId, {
      intent: "edit",
      ruleId: id,
      draft,
      at: new Date().toISOString(),
    });
    if (body.expected_version != null && Number(body.expected_version) !== plan.versionBefore) {
      throw new RuleSaveError(409, RULE_CHANGED_ELSEWHERE, "rule_changed");
    }
    const { result, choice } = await saveThroughPopup(gate, plan, body, "builder_edit");
    return NextResponse.json({
      ok: true,
      id: result.id,
      version: result.version,
      enabled: result.is_active,
      change: plan.change,
      skipped: choice === "skip",
    });
  } catch (e) {
    return ruleErrorResponse(e, "Could not save the rule. Try again in a moment.");
  }
}

export async function DELETE(_: Request, { params }: Params) {
  try {
    const { id } = await params;
    const supabase = isSupabaseConfigured() ? createClient(await cookies()) : undefined;
    if (supabase) {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      // Row security would leave a viewer's delete doing nothing; say why instead.
      const { data: rule } = await supabase.from("pricing_rules").select("hotel_id").eq("id", id).maybeSingle();
      if (rule?.hotel_id && !(await hasHotelRank(supabase, String(rule.hotel_id), "revenue_manager"))) {
        return NextResponse.json({ error: RULE_CHANGE_FORBIDDEN, code: "forbidden" }, { status: 403 });
      }
    }
    const ok = await deleteRule(id, supabase);
    if (!ok) {
      return NextResponse.json({ error: "Rule not found." }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete rule." },
      { status: 500 },
    );
  }
}
