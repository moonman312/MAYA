import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import { listEngineRules } from "@/lib/rules-store";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

/**
 * Rules in the full EngineRule shape, disabled ones included.
 *
 * GET /api/rules returns the lossy legacy RuleConfig — names instead of room
 * type ids, no ladder/pickup discriminator, no date window, no DOW mask, and a
 * flattened condition map whose operator semantics differ from the engine's.
 * The Rate Simulator can't preview honestly on that shape, so it reads this
 * instead and runs the same pure functions the engine runs.
 *
 * Disabled rules are included on purpose: "what would this do if I turned it
 * on" is the main thing anyone wants to simulate.
 */
export async function GET() {
  try {
    if (!isSupabaseConfigured()) {
      return NextResponse.json([]);
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
      return NextResponse.json([]);
    }

    const rules = await listEngineRules(supabase, hotelId, { includeInactive: true });
    return NextResponse.json(rules);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load rules." },
      { status: 500 },
    );
  }
}
