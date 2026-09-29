import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import {
  RoomTypeSetError,
  RuleAmountError,
  isRuleActionEmpty,
  isRuleConditionEmpty,
  roomTypeIdListError,
  ruleActionError,
  ruleConditionForInsert,
  undoOnCancellationError,
} from "@/lib/rule-form";
import { ruleErrorResponse, ruleGate, saveThroughPopup } from "@/lib/rule-route";
import { parseDraft, planRuleChange } from "@/lib/rule-save";
import { createRule, listRules } from "@/lib/rules-store";
import type { CreateRuleInput } from "@/lib/rules-store";
import type { RuleCondition } from "@/types/domain";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const supabase = isSupabaseConfigured() ? createClient(await cookies()) : undefined;
    let hotelId: string | null = null;
    if (supabase) {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      hotelId = await resolveAccessibleHotelId(supabase);
    }
    const rules = await listRules(supabase, hotelId);
    return NextResponse.json(rules);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load rules." },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Partial<CreateRuleInput>;

    const condClean = body.condition
      ? ruleConditionForInsert(body.condition as RuleCondition)
      : null;
    const hasStructured =
      !!condClean && !isRuleConditionEmpty(condClean);
    const hasLegacy =
      !!body.conditions &&
      typeof body.conditions === "object" &&
      Object.keys(body.conditions).length > 0;

    if (
      !body.rule_name ||
      (!hasLegacy && !hasStructured) ||
      isRuleActionEmpty(body.action ?? null)
    ) {
      return NextResponse.json({ error: "Invalid payload." }, { status: 400 });
    }
    // A percent and a fixed amount together is refused, not trimmed to one.
    const setError =
      ruleActionError(body.action) ??
      roomTypeIdListError(body.signal_room_type_ids, "measure") ??
      roomTypeIdListError(body.affected_room_type_ids, "change") ??
      undoOnCancellationError(body.undo_on_cancellation);
    if (setError) {
      return NextResponse.json({ error: setError }, { status: 400 });
    }

    // A rule saved on goes through the activation popup: the builder sends
    // the id the popup previewed it under and the owner's Apply or Skip
    // (src/lib/rule-route.ts). Only a rule saved off (the Rate Simulator's
    // Save This Rule) and demo mode take the plain path below.
    if (isSupabaseConfigured() && body.is_active !== false) {
      return await createThroughPopup(body as Record<string, unknown>);
    }

    const supabase = isSupabaseConfigured() ? createClient(await cookies()) : undefined;
    let hotelId: string | null = null;
    if (supabase) {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      hotelId = await resolveAccessibleHotelId(supabase);
      if (!hotelId) {
        return NextResponse.json(
          { error: "You don't have access to this property." },
          { status: 400 },
        );
      }
    }
    const rule = await createRule(
      {
        rule_name: body.rule_name,
        conditions: body.conditions ?? {},
        action: body.action!,
        room_types: body.room_types ?? [],
        start_date: body.start_date,
        end_date: body.end_date,
        is_annual: body.is_annual,
        dow_mask: body.dow_mask,
        priority: body.priority,
        signal_room_type_ids: body.signal_room_type_ids,
        affected_room_type_ids: body.affected_room_type_ids,
        condition: hasStructured ? condClean! : undefined,
        // Only an explicit `false` turns a rule off at birth — anything else,
        // including a missing or malformed field, still creates it enabled, so
        // the existing Rules-tab form is untouched by this.
        is_active: body.is_active === false ? false : undefined,
        // Ticked unless the request says false (checked above).
        undo_on_cancellation: body.undo_on_cancellation !== false,
      },
      supabase,
      hotelId,
    );

    return NextResponse.json(rule, { status: 201 });
  } catch (error) {
    if (error instanceof RoomTypeSetError || error instanceof RuleAmountError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create rule." },
      { status: 500 },
    );
  }
}

async function createThroughPopup(body: Record<string, unknown>) {
  const gate = await ruleGate();
  if (!gate.ok) return gate.response;
  try {
    const draft = parseDraft(body);
    const plan = await planRuleChange(gate.admin, gate.hotelId, {
      intent: "create",
      ruleId: body.id,
      draft,
      at: new Date().toISOString(),
    });
    const { result, choice } = await saveThroughPopup(gate, plan, body, "builder_new");
    return NextResponse.json(
      { id: result.id, version: result.version, enabled: result.is_active, skipped: choice === "skip" },
      { status: 201 },
    );
  } catch (e) {
    return ruleErrorResponse(e, "Could not save the rule. Try again in a moment.");
  }
}
