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

import { checkCode, displayEffectFor } from "@/lib/billing/codes";
import { enforceRateLimit } from "@/lib/rate-limit";
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

  // The gate is deliberate scarcity, so this is the endpoint worth guessing at.
  // The shape check in checkCode already refuses wildcards; this bounds the
  // brute force that remains. Keyed on the user, which costs an email address
  // per bucket rather than a request.
  const throttled = await enforceRateLimit("codeCheck", user.id,
    "Too many code attempts. Wait a few minutes and try again.");
  if (throttled) return throttled;

  const body = (await request.json().catch(() => null)) as
    | { code?: string; interval?: string }
    | null;
  const typed = (body?.code ?? "").trim();
  if (!typed) {
    return NextResponse.json({ valid: false, message: "Enter your code to continue." });
  }

  // Checked against the period they are actually buying, so this verdict and the
  // one checkout reaches cannot differ — a fixed price is agreed per period, and
  // a limited discount is worth different money on a yearly invoice.
  const interval = body?.interval === "year" ? "year" : "month";

  // signup_codes is platform-admin only under RLS, and whoever is signing up is
  // not an admin — so the lookup runs service-role and returns only a verdict.
  const check = await checkCode(createAdminClient(), typed, { interval });

  // The effect ships alongside the prose so the panel can price from it — a
  // fixed-price code moves the billed count, and a screen that quotes the
  // typed rooms instead is promising a number Stripe will not charge.
  return NextResponse.json(
    check.ok
      ? { valid: true, grants: check.describe, effect: displayEffectFor(check.code, interval) }
      : { valid: false, message: check.message },
  );
}
