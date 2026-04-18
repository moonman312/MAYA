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
    const ok = await updateRule(id, body, supabase);
    if (!ok) {
      return NextResponse.json({ error: "Rule not found or update failed." }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
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
