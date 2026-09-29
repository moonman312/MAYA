/**
 * POST /api/manual-price/retry { hotelId, roomTypeId, date } — one more send
 * of a night's price that the property system refused and the push has
 * stopped retrying (lib/pms/send-status.ts: state "failed", its tries used at
 * this price or its cause held).
 *
 * The push decides for itself what to send (rate-push.ts), so this route does
 * not send anything. It stamps rate_updates.retry_requested_at on the failed
 * row, which the push's retry decision reads as "one more try" until its own
 * write moves pushed_at past the stamp, then nudges the hotel's sync so that
 * try is now rather than on the next cycle.
 *
 * Idempotent: a stamp already newer than the last try is left alone and
 * nudges nothing (`alreadyRequested`), so a double click or a second tab
 * never sends twice. Same door as typing a price (../gate.ts): the same rank,
 * the same budget.
 */

import { dbErrorResponse, isRealIsoDate, isUuid, NOT_READY_YET } from "@/lib/api-guards";
import { isMissingColumnError } from "@/lib/engine/snapshots";
import { readSendStatus, type SendStatus } from "@/lib/pms/send-status";
import { nudgeHotelSync } from "@/lib/pms/sync-nudge";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { bad, gate, readBody } from "../gate";

type RetryBody = { hotelId?: unknown; roomTypeId?: unknown; date?: unknown };

/** Why there is nothing to retry, in the owner's words, for a 409. */
function nothingToRetry(status: SendStatus): string {
  const pms = status.pmsName ?? "your PMS";
  switch (status.state) {
    case "sent":
      return `This price has already been sent to ${pms}.`;
    case "sending":
      return `MAYA is sending this price to ${pms} now.`;
    case "retrying":
      return "MAYA is already retrying this price.";
    default:
      return "There is nothing to retry for this night.";
  }
}

/**
 * Stamps the row, once. The filter repeats what the read saw (no stamp, or
 * one no newer than the last try), so two presses that read the same row
 * write it once: the second finds it stamped and changes nothing.
 */
async function requestRetry(
  admin: SupabaseClient,
  p: { hotelId: string; roomTypeId: string; date: string; lastAttemptAt: string | null },
  now: string,
): Promise<boolean> {
  let q = admin
    .from("rate_updates")
    .update({ retry_requested_at: now })
    .eq("hotel_id", p.hotelId)
    .eq("room_type_id", p.roomTypeId)
    .eq("stay_date", p.date)
    .eq("status", "failed");
  q = p.lastAttemptAt
    ? q.or(`retry_requested_at.is.null,retry_requested_at.lte.${p.lastAttemptAt}`)
    : q.is("retry_requested_at", null);
  const { data, error } = await q.select("stay_date");
  if (error) throw error;
  return ((data ?? []) as unknown[]).length > 0;
}

export async function POST(req: Request) {
  try {
    const body = await readBody<RetryBody>(req);
    const gated = await gate(body.hotelId);
    if (!gated.ok) return gated.response;
    const { admin } = gated;
    const hotelId = body.hotelId as string;
    const { roomTypeId, date } = body;
    if (typeof roomTypeId !== "string" || !isUuid(roomTypeId)) return bad("Pick a room type.");
    if (typeof date !== "string" || !isRealIsoDate(date)) return bad("date must be a real date (YYYY-MM-DD).");

    const status = await readSendStatus(admin, { hotelId, roomTypeId, date });
    if (status.applicable && status.state === "retrying" && status.retryRequested) {
      return NextResponse.json({ ok: true, state: "retrying", alreadyRequested: true });
    }
    if (!status.applicable || status.state !== "failed") {
      return NextResponse.json({ error: nothingToRetry(status), state: status.state }, { status: 409 });
    }

    const written = await requestRetry(
      admin,
      { hotelId, roomTypeId, date, lastAttemptAt: status.lastAttemptAt },
      new Date().toISOString(),
    );
    // Somebody else's press landed between the read and the write.
    if (!written) return NextResponse.json({ ok: true, state: "retrying", alreadyRequested: true });

    const nudged = await nudgeHotelSync(admin, hotelId);
    return NextResponse.json({ ok: true, state: "retrying", alreadyRequested: false, nudged });
  } catch (error) {
    if (isMissingColumnError(error)) {
      console.error(
        JSON.stringify({
          fn: "manual-price/retry",
          warning:
            "rate_updates.retry_requested_at is missing — run 99_supabase_migration_manual_price_retry_v1.sql",
        }),
      );
      return NextResponse.json({ error: NOT_READY_YET }, { status: 503 });
    }
    const { status, message } = dbErrorResponse(error);
    return NextResponse.json({ error: message }, { status });
  }
}
