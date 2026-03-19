import { SAMPLE_RESERVATIONS } from "@/lib/demo-data";
import { listRules } from "@/lib/rules-store";
import { simulateRateChanges } from "@/lib/rules-engine";
import type { SimulationReservation } from "@/types/domain";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { reservations?: SimulationReservation[] };
    const reservations = body.reservations ?? SAMPLE_RESERVATIONS;

    const supabase = isSupabaseConfigured() ? createClient(await cookies()) : undefined;
    if (supabase) {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }
    const rules = await listRules(supabase);
    const enabled = rules.filter((r) => r.enabled);
    const result = simulateRateChanges(enabled, reservations);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to run simulation." },
      { status: 500 },
    );
  }
}
