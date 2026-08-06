import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

/**
 * How often each rule has actually fired, keyed by rule id:
 * ladder activations (state-based rules turning on) + pickup events
 * (each recorded surge). Drives the "sort by most fired" rules list.
 */
export async function GET() {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({}); // demo mode — no history to count
  }
  const supabase = createClient(await cookies());
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const hotelId = await resolveAccessibleHotelId(supabase);
  if (!hotelId) {
    return NextResponse.json({});
  }

  const [{ data: ladder }, { data: pickup }] = await Promise.all([
    supabase
      .from("ladder_transition_event")
      .select("rule_id")
      .eq("hotel_id", hotelId)
      .eq("transition", "activate"),
    supabase.from("pickup_event").select("rule_id").eq("hotel_id", hotelId),
  ]);

  const counts: Record<string, number> = {};
  for (const row of [...(ladder ?? []), ...(pickup ?? [])]) {
    const id = String(row.rule_id);
    counts[id] = (counts[id] ?? 0) + 1;
  }

  return NextResponse.json(counts);
}
