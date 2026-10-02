/**
 * Cron entry point for room-count truing (see lib/billing/room-truing.ts).
 *
 * Machine-only, and authorized exactly like the card re-check next door: a
 * shared secret in a header, nothing signed-in, so a missing secret takes the
 * route down rather than leaving it open. This one raises what a customer is
 * charged, which makes it the last route in the app that should have a path
 * reachable from a browser.
 */

import { createAdminClient } from "@/utils/supabase/admin";
import { stripeClient } from "@/lib/billing/stripe";
import { guardBillingCron } from "@/lib/billing/cron-guard";
import { sweepRoomTruing } from "@/lib/billing/room-truing";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A full batch is ~2 Stripe round trips per hotel, run sequentially.
export const maxDuration = 60;

export async function POST(request: Request) {
  const refused = await guardBillingCron(request, "roomTruingRoute");
  if (refused) return refused;

  const result = await sweepRoomTruing({
    admin: createAdminClient(),
    stripe: stripeClient(),
    now: new Date(),
  });

  // 200 even with per-hotel failures: they are logged individually, and a
  // non-2xx would make pg_cron replay a sweep that already charged people.
  return NextResponse.json({ ok: true, ...result });
}
