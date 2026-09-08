import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import { projectStrategyOntoRoomTypes } from "@/lib/onboarding/project-strategy";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

type AnswersBody = {
  propertyName?: string;
  turnCost?: number | null;
  floor?: number | null;
  ceiling?: number | null;
  confidence?: "automate_current" | "find_upside" | null;
  completed?: boolean;
};

/**
 * Saves strategy answers (all optional). Raw answers merge into
 * onboarding_states.questions; normalized values land on hotel_settings and
 * are projected onto room_types guardrails. A user-entered property name
 * always wins over the PMS-derived one.
 */
export async function POST(request: Request) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
  }

  const supabase = createClient(await cookies());
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const hotelId = await resolveAccessibleHotelId(supabase);
  if (!hotelId) {
    return NextResponse.json({ error: "No hotel connected yet" }, { status: 400 });
  }

  const body = (await request.json().catch(() => null)) as AnswersBody | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const floor = numOrNull(body.floor);
  const ceiling = numOrNull(body.ceiling);
  const turnCost = numOrNull(body.turnCost);
  if (floor !== null && ceiling !== null && floor >= ceiling) {
    return NextResponse.json(
      { error: "Your floor price needs to be below your ceiling price." },
      { status: 400 },
    );
  }

  // Rename: user input wins. A name collision is a real conflict — tell them.
  if (typeof body.propertyName === "string" && body.propertyName.trim()) {
    const { error: nameErr } = await supabase
      .from("hotels")
      .update({ name: body.propertyName.trim() })
      .eq("id", hotelId);
    if (nameErr) {
      const conflict = nameErr.code === "23505";
      return NextResponse.json(
        {
          error: conflict
            ? "That property name is already taken — try adding your city or neighborhood."
            : nameErr.message,
        },
        { status: conflict ? 409 : 500 },
      );
    }
  }

  // Merge raw answers into onboarding_states.questions.
  const { data: state } = await supabase
    .from("onboarding_states")
    .select("questions")
    .eq("hotel_id", hotelId)
    .maybeSingle();
  const merged = {
    ...((state?.questions as Record<string, unknown>) ?? {}),
    ...(body.propertyName !== undefined ? { propertyName: body.propertyName } : {}),
    ...(body.turnCost !== undefined ? { turnCost } : {}),
    ...(body.floor !== undefined ? { floor } : {}),
    ...(body.ceiling !== undefined ? { ceiling } : {}),
    ...(body.confidence !== undefined ? { confidence: body.confidence } : {}),
  };
  await supabase
    .from("onboarding_states")
    .update({
      questions: merged,
      ...(body.completed ? { questions_completed_at: new Date().toISOString() } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("hotel_id", hotelId);

  // Normalized values -> hotel_settings.
  const settingsPatch: Record<string, unknown> = {};
  if (body.floor !== undefined) settingsPatch.strategy_floor = floor;
  if (body.ceiling !== undefined) settingsPatch.strategy_ceiling = ceiling;
  if (body.confidence !== undefined) settingsPatch.pricing_confidence = body.confidence;
  if (Object.keys(settingsPatch).length > 0) {
    const { error: setErr } = await supabase
      .from("hotel_settings")
      .update({ ...settingsPatch, updated_at: new Date().toISOString() })
      .eq("hotel_id", hotelId);
    if (setErr) {
      return NextResponse.json({ error: setErr.message }, { status: 500 });
    }
    await projectStrategyOntoRoomTypes(supabase, hotelId);
  }

  return NextResponse.json({ ok: true });
}

function numOrNull(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  return Math.round(v * 100) / 100;
}
