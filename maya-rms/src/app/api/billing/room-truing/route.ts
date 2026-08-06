/**
 * Cron entry point for room-count truing (see lib/billing/room-truing.ts).
 *
 * Machine-only, and authorized exactly like the card re-check next door: a
 * shared secret in a header, nothing signed-in, so a missing secret takes the
 * route down rather than leaving it open. This one raises what a customer is
 * charged, which makes it the last route in the app that should have a path
 * reachable from a browser.
 */

import { createAdminClient, isAdminConfigured } from "@/utils/supabase/admin";
import { isStripeConfigured, stripeClient } from "@/lib/billing/stripe";
import { sweepRoomTruing } from "@/lib/billing/room-truing";
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A full batch is ~2 Stripe round trips per hotel, run sequentially.
export const maxDuration = 60;

const SECRET_HEADER = "x-billing-cron-secret";

/** Constant time: a `!==` on a secret leaks its length to a patient caller. */
function secretMatches(presented: string | null, expected: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  const secret = process.env.BILLING_CRON_SECRET;
  if (!secret) {
    console.error(JSON.stringify({ fn: "roomTruingRoute", error: "BILLING_CRON_SECRET missing" }));
    return NextResponse.json({ error: "Not configured" }, { status: 503 });
  }
  if (!secretMatches(request.headers.get(SECRET_HEADER), secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isStripeConfigured() || !isAdminConfigured()) {
    return NextResponse.json({ error: "Billing is not configured" }, { status: 503 });
  }

  const result = await sweepRoomTruing({
    admin: createAdminClient(),
    stripe: stripeClient(),
    now: new Date(),
  });

  // 200 even with per-hotel failures: they are logged individually, and a
  // non-2xx would make pg_cron replay a sweep that already charged people.
  return NextResponse.json({ ok: true, ...result });
}
