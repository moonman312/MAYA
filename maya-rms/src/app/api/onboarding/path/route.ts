import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

/**
 * Records the user's onboarding path choice on their profile.
 * "self_serve" also stamps onboarding_dismissed_at so the dashboard
 * stops redirecting them here.
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

  const body = (await request.json().catch(() => null)) as { path?: string } | null;
  const path = body?.path;
  if (path !== "guided" && path !== "self_serve") {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  // Upsert: profile rows are trigger-created for new users, but older
  // accounts may predate the trigger.
  const { error } = await supabase.from("profiles").upsert(
    {
      id: user.id,
      onboarding_path: path,
      onboarding_dismissed_at: path === "self_serve" ? new Date().toISOString() : null,
    },
    { onConflict: "id" },
  );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
