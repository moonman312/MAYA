/**
 * Ask a hotel's scheduled sync to run now instead of at its next tick.
 *
 * Owner edits that move prices (a typed price, a room type counted or not,
 * rooms out of service, "price everything again") are recorded by database
 * triggers as nights, or a whole hotel, to price again
 * (99_supabase_migration_pricing_cadence_v1.sql). The scheduled sync prices
 * them; this only saves waiting up to five minutes for it. Each sync function
 * accepts `{ hotel_id }` for a single-property run and takes the same lease a
 * scheduled claim does, so a nudge never runs a hotel twice at once.
 *
 * Sent after the response, not fire-and-forget: a serverless instance can be
 * frozen the moment the reply is sent, before the request leaves the socket.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { after } from "next/server";

/**
 * Which sync function to nudge for a hotel's PMS, and the secret it checks.
 * A PMS not listed here is priced on its own cron cycle.
 */
export const SYNC_NUDGE: Record<string, { fn: string; header: string; env: string }> = {
  cloudbeds: { fn: "cloudbeds-scheduled-sync", header: "x-cloudbeds-cron-secret", env: "CLOUDBEDS_CRON_SECRET" },
  think: { fn: "think-scheduled-sync", header: "x-think-cron-secret", env: "THINK_CRON_SECRET" },
  mews: { fn: "mews-scheduled-sync", header: "x-mews-cron-secret", env: "MEWS_CRON_SECRET" },
};

/** The PMS this hotel is connected to; a live connection wins over a stale one. */
export async function hotelPmsType(admin: SupabaseClient, hotelId: string): Promise<string> {
  const { data } = await admin.from("pms_connections").select("pms_type, status").eq("hotel_id", hotelId);
  const rows = data ?? [];
  const live = rows.find((r) => r.status === "connected") ?? rows[0];
  return live ? String(live.pms_type) : "";
}

/**
 * Schedules the hotel's sync to run once the response is out. "next_cycle"
 * when there is nothing to nudge (no PMS, or the function's URL or secret is
 * not configured here): the scheduled tick picks the change up.
 */
export async function nudgeHotelSync(admin: SupabaseClient, hotelId: string): Promise<"nudged" | "next_cycle"> {
  const nudge = SYNC_NUDGE[await hotelPmsType(admin, hotelId)];
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
  const secret = nudge ? process.env[nudge.env] : undefined;
  if (!nudge || !supabaseUrl || !secret) return "next_cycle";
  after(() =>
    fetch(`${supabaseUrl}/functions/v1/${nudge.fn}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", [nudge.header]: secret },
      body: JSON.stringify({ hotel_id: hotelId }),
    }).catch(() => {
      // The scheduled tick prices it within five minutes.
    }),
  );
  return "nudged";
}
