import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import { createRule, listRules } from "@/lib/rules-store";
import type { RuleConfig } from "@/types/domain";
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

type CreateRuleBody = Pick<RuleConfig, "rule_name" | "conditions" | "action" | "room_types">;

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Partial<CreateRuleBody>;

    if (!body.rule_name || !body.conditions || !body.action) {
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
          { error: "No accessible hotel. Set MAYA_DEFAULT_HOTEL_ID or a hotel membership." },
          { status: 400 },
        );
      }
    }
    const rule = await createRule(
      {
        rule_name: body.rule_name,
        conditions: body.conditions,
        action: body.action,
        room_types: body.room_types ?? [],
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
