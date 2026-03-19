import { getCalendar } from "@/lib/calendar-store";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

type Params = { params: Promise<{ year: string; month: string }> };

export async function GET(_: Request, { params }: Params) {
  try {
    const { year, month } = await params;
    const y = Number(year);
    const m = Number(month);
    if (Number.isNaN(y) || Number.isNaN(m) || m < 1 || m > 12) {
      return NextResponse.json({ error: "use /api/calendar/YYYY/MM" }, { status: 400 });
    }

    const supabase =
      isSupabaseConfigured() ? createClient(await cookies()) : undefined;
    if (supabase) {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    const calendar = await getCalendar(y, m, supabase);
    return NextResponse.json(calendar);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load calendar." },
      { status: 500 },
    );
  }
}
