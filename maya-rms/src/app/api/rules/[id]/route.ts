import { hasHotelRank } from "@/lib/require-supabase-hotel";
import {
  RULE_CHANGE_FORBIDDEN,
  RoomTypeSetError,
  RuleAmountError,
  roomTypeIdListError,
  ruleActionError,
  undoOnCancellationError,
} from "@/lib/rule-form";
import { deleteRule, updateRule } from "@/lib/rules-store";
import type { UpdateRuleInput } from "@/lib/rules-store";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

type Params = { params: Promise<{ id: string }> };

export async function PUT(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const supabase = isSupabaseConfigured() ? createClient(await cookies()) : undefined;
    if (!supabase) {
      return NextResponse.json({ error: "Supabase required for rule updates." }, { status: 501 });
    }

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json()) as Partial<UpdateRuleInput>;
    const setError =
      ruleActionError(body.action) ??
      roomTypeIdListError(body.signal_room_type_ids, "measure") ??
      roomTypeIdListError(body.affected_room_type_ids, "change") ??
      undoOnCancellationError(body.undo_on_cancellation);
    if (setError) {
      return NextResponse.json({ error: setError }, { status: 400 });
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
