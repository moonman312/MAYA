/**
 * The reads behind src/lib/price-mode.ts, for any route that words an event
 * for the mode it happened in (the change log, a rule's fire log): the
 * property's mode history, the system its prices go to, and the send
 * ledger's reading of some nights (changelog-send-lines.ts).
 *
 * Every read degrades rather than fails: without the history table, or when a
 * read errors, an event's mode is "unknown" and it is worded as the log
 * always worded it, claiming nothing about sending.
 */

import { readSendFacts, type SendFacts } from "@/lib/changelog-send-lines";
import { isMissingRelationError } from "@/lib/engine/snapshots";
import { modeTimelineFrom, pmsSendsPrices, type ModeTimeline } from "@/lib/price-mode";
import { pickConnection } from "@/lib/simulation-strip";
import { createAdminClient, isAdminConfigured } from "@/utils/supabase/admin";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The property's mode history (hotel_mode_history), oldest first, read under
 * the caller's session (members read their own property's). Empty when the
 * table is not there yet or the read fails.
 */
export async function loadModeTimeline(supabase: SupabaseClient, hotelId: string, fn = "price-mode"): Promise<ModeTimeline> {
  const { data, error } = await supabase
    .from("hotel_mode_history")
    .select("since, simulated, recorded_at")
    .eq("hotel_id", hotelId)
    .order("since", { ascending: true })
    .limit(1000);
  if (error) {
    if (!isMissingRelationError(error)) {
      console.error(JSON.stringify({ fn, step: "mode_history", hotelId, error: String(error.message).slice(0, 300) }));
    }
    return [];
  }
  return modeTimelineFrom(data as { since?: unknown; simulated?: unknown; recorded_at?: unknown }[] | null);
}

/** The property system prices go to, or would: a working connection first, then one MAYA keeps trying, then any. */
export async function loadPmsType(supabase: SupabaseClient, hotelId: string): Promise<string | null> {
  const { data, error } = await supabase.from("pms_connections").select("pms_type, status").eq("hotel_id", hotelId);
  if (error) return null;
  const pick = pickConnection((data ?? []) as { pms_type?: unknown; status?: unknown }[]);
  return pick?.pms_type != null ? String(pick.pms_type) : null;
}

/** Where prices go, and the property's date today: what a send line needs besides the ledger. */
export type SendContext = { hotelId: string; pmsType: string | null; today: string; now: Date };

/**
 * The send ledger's reading of these nights, read with the service role
 * (rate_updates is a manager's read under RLS; the change log and the fire
 * log are everyone's) once the caller's access to the property is known.
 * Null without the service role or when the read fails: then nothing live
 * claims a send. Where nothing is sent (a simulated property's events need
 * no ledger; Mews has none), the answer needs no read.
 */
export async function sendFactsFor(
  ctx: SendContext,
  cells: { stay_date: string; room_type_id: string }[],
  fn = "price-mode",
): Promise<SendFacts | null> {
  const empty: SendFacts = { pmsType: ctx.pmsType, ledger: new Map(), published: new Map(), today: ctx.today, nowMs: ctx.now.getTime() };
  if (!pmsSendsPrices(ctx.pmsType) || cells.length === 0) return empty;
  if (!isAdminConfigured()) return null;
  try {
    return await readSendFacts(createAdminClient(), ctx, cells);
  } catch (e) {
    const message = e instanceof Error ? e.message : String((e as { message?: unknown } | null)?.message ?? e);
    console.error(JSON.stringify({ fn, step: "send_ledger", hotelId: ctx.hotelId, error: message.slice(0, 300) }));
    return null;
  }
}
