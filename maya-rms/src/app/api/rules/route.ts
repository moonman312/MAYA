import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import {
  isRuleActionEmpty,
  isRuleConditionEmpty,
  ruleConditionForInsert,
} from "@/lib/rule-form";
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
          {
            error:
              "No accessible hotel. You need a hotel membership or a dev default hotel configured.",
          },
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
      },
      supabase,
      hotelId,
    );

    return NextResponse.json(rule, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create rule." },
      { status: 500 },
    );
  }
}
