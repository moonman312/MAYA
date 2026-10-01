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
import { modeSwitchesFrom, modeTimelineFrom, pmsSendsPrices, type ModeSwitch, type ModeTimeline } from "@/lib/price-mode";
import { pickConnection } from "@/lib/simulation-strip";
import { createAdminClient, isAdminConfigured } from "@/utils/supabase/admin";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The property's mode history (hotel_mode_history), oldest first, read under
 * the caller's session (members read their own property's): the timeline
 * every event's mode is read off, and the switches people made. Empty when
 * the table is not there yet or the read fails.
 */
export async function loadModeHistory(
  supabase: SupabaseClient,
  hotelId: string,
  fn = "price-mode",
): Promise<{ timeline: ModeTimeline; switches: ModeSwitch[] }> {
  const { data, error } = await supabase
    .from("hotel_mode_history")
    .select("since, simulated, recorded_at, source, changed_by")
    .eq("hotel_id", hotelId)
    .order("since", { ascending: true })
    .limit(1000);
  if (error) {
    if (!isMissingRelationError(error)) {
      console.error(JSON.stringify({ fn, step: "mode_history", hotelId, error: String(error.message).slice(0, 300) }));
    }
    return { timeline: [], switches: [] };
  }
  const rows = data as { since?: unknown; simulated?: unknown; recorded_at?: unknown; source?: unknown; changed_by?: unknown }[] | null;
  return { timeline: modeTimelineFrom(rows), switches: modeSwitchesFrom(rows) };
}

/** The property's mode timeline alone (loadModeHistory). */
export async function loadModeTimeline(supabase: SupabaseClient, hotelId: string, fn = "price-mode"): Promise<ModeTimeline> {
  return (await loadModeHistory(supabase, hotelId, fn)).timeline;
}

/**
 * Whether the property is live now (hotel_settings.simulation_mode false),
 * under the caller's session; a missing row is simulation, as the push reads
 * it. Null when it can't be read.
 */
export async function loadLiveNow(supabase: SupabaseClient, hotelId: string): Promise<boolean | null> {
  const { data, error } = await supabase.from("hotel_settings").select("simulation_mode").eq("hotel_id", hotelId).maybeSingle();
  if (error) return null;
  return (data as { simulation_mode?: unknown } | null)?.simulation_mode === false;
}

/** The property system prices go to, or would: a working connection first, then one MAYA keeps trying, then any. */
export async function loadPmsType(supabase: SupabaseClient, hotelId: string): Promise<string | null> {
  const { data, error } = await supabase.from("pms_connections").select("pms_type, status").eq("hotel_id", hotelId);
  if (error) return null;
  const pick = pickConnection((data ?? []) as { pms_type?: unknown; status?: unknown }[]);
  return pick?.pms_type != null ? String(pick.pms_type) : null;
}

/**
 * Where prices go, the property's date today, and whether it is live now
 * (loadLiveNow; unset or null when not known): what a send line needs
 * besides the ledger.
 */
export type SendContext = { hotelId: string; pmsType: string | null; today: string; now: Date; liveNow?: boolean | null };

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
  const empty: SendFacts = {
    pmsType: ctx.pmsType,
    ledger: new Map(),
    published: new Map(),
    today: ctx.today,
    nowMs: ctx.now.getTime(),
    liveNow: ctx.liveNow === true,
  };
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
