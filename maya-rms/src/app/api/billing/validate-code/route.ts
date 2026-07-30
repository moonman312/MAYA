/**
 * Checks a signup code before anyone reaches checkout.
 *
 * Deliberately says nothing a caller couldn't already learn by trying the code
 * at checkout — valid or not, and what it grants if so. It does not reveal how
 * many redemptions remain or anything about other properties, since this is
 * reachable by any signed-in user.
 *
 * Requires a session: without one this would be an oracle for guessing codes at
 * whatever rate the network allows.
 */

import { checkCode } from "@/lib/billing/codes";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
  }

  const supabase = createClient(await cookies());
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const body = (await request.json().catch(() => null)) as { code?: string } | null;
  const typed = (body?.code ?? "").trim();
  if (!typed) {
    return NextResponse.json({ valid: false, message: "Enter your code to continue." });
  }

  // signup_codes is platform-admin only under RLS, and whoever is signing up is
  // not an admin — so the lookup runs service-role and returns only a verdict.
  const check = await checkCode(createAdminClient(), typed);

  return NextResponse.json(
    check.ok
      ? { valid: true, grants: check.describe }
      : { valid: false, message: check.message },
  );
}
