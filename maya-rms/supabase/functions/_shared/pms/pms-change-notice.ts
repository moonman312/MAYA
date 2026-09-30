/**
 * The two emails about rates changed in the property system (Jake,
 * 2026-09-30), sent from what the base rate refresh wrote down in
 * pms_change_notices (pms-change-watch.ts) to the property's General
 * Managers and Hotel Admins, the same people as the connection email
 * (outage-notice.ts recipientsFor):
 *
 *   - the overwrites ("MAYA's price wins"): at most one email a day per
 *     property. The day's overwrites are sent on the first run after that day
 *     ends at the property (its time zone), listing each night and room type
 *     once, with the PMS's rate (or "removed"), MAYA's price and how many
 *     times MAYA sent it again that day. pms_change_watch.digest_sent_on is
 *     the property date the last one went out; it is claimed before anything
 *     is sent, so two runs can't both send the day's email.
 *   - the warning ("Keep the change"): once, on the next run after the
 *     refresh wrote it. Not sent when the setting was turned on since.
 *
 * Where it runs: each scheduled sync calls sendDuePmsChangeEmails for its own
 * PMS once per fleet invocation, before claiming hotels, as it does the
 * connection email. The cost is one read on a partial index (items not
 * emailed yet) that is empty nearly all the time.
 *
 * Exactly once: the items are stamped (emailed_at) in a conditional update
 * before anything is sent. When every email then fails, the stamps are
 * handed back and a later run tries again, for RETRY_FOR_MS. A property that
 * stopped paying gets no email, and its items are stamped all the same. While
 * email isn't set up (no Resend secrets) nothing is stamped, so the first run
 * after it is set sends what is due.
 *
 * Time: at most HOTELS_PER_RUN properties and about RUN_BUDGET_MS per
 * invocation. Never throws: a failed email must not cost anyone a sync.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { isPaidLiveHotel } from "../billing/entitlement.ts";
import { isResendConfigured, sendEmail, type SendEmailInput } from "../email/resend.ts";
import { isMissingColumnError, isMissingRelationError } from "../engine/snapshots.ts";
import { evalIsoToHotelDateString, hotelDayStartIso } from "../engine/timezone.ts";
import { recipientsFor, type Recipient } from "./outage-notice.ts";
import {
  type ChangePms,
  emailCurrencySymbol,
  otherToolHtml,
  otherToolSubject,
  otherToolText,
  type OverwriteLine,
  overwriteHtml,
  overwriteSubject,
  overwriteText,
} from "./pms-change-email.ts";

/** Properties one invocation emails at most. The rest wait for the next. */
export const HOTELS_PER_RUN = 5;
/** Time one invocation gives these emails before it gets on with the syncs. */
export const RUN_BUDGET_MS = 20_000;
/** An email whose sends all failed is tried again until it is this late. */
export const RETRY_FOR_MS = 12 * 60 * 60 * 1000;
/** Items read per invocation. */
const ROWS_READ = 1000;

const REPLY_TO = "info@modern-hospitality-solutions.com";
const DEFAULT_APP_URL = "https://maya-rms.com";

function readEnv(name: string): string | undefined {
  const v =
    (typeof process !== "undefined" ? process.env?.[name] : undefined) ??
    (globalThis as { Deno?: { env?: { get(k: string): string | undefined } } }).Deno?.env?.get(name);
  return v && v !== "" ? v : undefined;
}

export type PmsChangeEmailDeps = {
  now?: () => number;
  /** The wall clock RUN_BUDGET_MS is measured on. Date.now; tests move it. */
  clock?: () => number;
  send?: (input: SendEmailInput) => Promise<{ id: string }>;
  emailConfigured?: () => boolean;
  /** The app's origin; MAYA_APP_URL, else https://maya-rms.com. */
  appUrl?: string;
};

export type PmsChangeEmailResult = {
  hotelId: string;
  email: "overwrites" | "other_tool";
  outcome: "emailed" | "not_emailed" | "retry";
  reason?: string;
  recipients?: number;
  sent?: number;
  /** Items the email covered. */
  items?: number;
};

type NoticeRow = {
  id: string;
  hotel_id: string;
  kind: string;
  found_at: string;
  stay_date: string | null;
  room_type_id: string | null;
  pms_rate: number | null;
  maya_price: number | null;
  rates: number | null;
};

function log(line: Record<string, unknown>, level: "log" | "error" = "log"): void {
  console[level](JSON.stringify({ fn: "pmsChangeEmail", ...line }));
}

function errorText(e: unknown): string {
  return (e instanceof Error ? e.message : String((e as { message?: unknown } | null)?.message ?? e)).slice(0, 300);
}

async function logEvent(supabase: SupabaseClient, hotelId: string, detail: Record<string, unknown>): Promise<void> {
  try {
    await supabase.rpc("platform_log_event", {
      p_event_type: "pms.change_email",
      p_entity_type: "hotel",
      p_entity_id: hotelId,
      p_hotel_id: hotelId,
      p_detail: detail,
    });
  } catch {
    // The console line is the record.
  }
}

/** The property's date for an instant, in its own time zone (UTC when the zone is unknown). */
function hotelDate(iso: string, timeZone: string): string {
  try {
    return evalIsoToHotelDateString(iso, timeZone);
  } catch {
    return evalIsoToHotelDateString(iso, "UTC");
  }
}

function dayStart(ymd: string, timeZone: string): string {
  try {
    return hotelDayStartIso(ymd, timeZone);
  } catch {
    return hotelDayStartIso(ymd, "UTC");
  }
}

/** "Fri, Nov 13" for a stay date. */
export function nightLabel(ymd: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).formatToParts(
    new Date(`${ymd}T12:00:00Z`),
  );
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("weekday")}, ${get("month")} ${get("day")}`;
}

/** "Monday, October 5" for a property date. */
export function dayLabel(ymd: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" }).formatToParts(
    new Date(`${ymd}T12:00:00Z`),
  );
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("weekday")}, ${get("month")} ${get("day")}`;
}

function money(amount: number, symbol: string): string {
  return `${symbol}${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * One line per night and room type, nearest night first: the newest rate the
 * PMS had and MAYA's price, and how many times MAYA sent it again.
 */
export function overwriteLines(
  rows: Pick<NoticeRow, "stay_date" | "room_type_id" | "pms_rate" | "maya_price" | "found_at">[],
  roomTypeNames: Map<string, string>,
  currencySymbol: string,
): OverwriteLine[] {
  const byCell = new Map<string, { stayDate: string; roomType: string; newest: (typeof rows)[number]; times: number }>();
  for (const r of rows) {
    if (!r.stay_date || !r.room_type_id || r.maya_price == null) continue;
    const stayDate = String(r.stay_date).slice(0, 10);
    const key = `${stayDate}|${r.room_type_id}`;
    const seen = byCell.get(key);
    if (!seen) {
      byCell.set(key, { stayDate, roomType: roomTypeNames.get(String(r.room_type_id)) ?? "A room type", newest: r, times: 1 });
      continue;
    }
    seen.times += 1;
    if (Date.parse(r.found_at) >= Date.parse(seen.newest.found_at)) seen.newest = r;
  }
  return [...byCell.values()]
    .sort((a, b) => a.stayDate.localeCompare(b.stayDate) || a.roomType.localeCompare(b.roomType))
    .map((c) => ({
      night: nightLabel(c.stayDate),
      roomType: c.roomType,
      theirs: c.newest.pms_rate == null ? null : money(Number(c.newest.pms_rate), currencySymbol),
      maya: money(Number(c.newest.maya_price), currencySymbol),
      times: c.times,
    }));
}

/** "on Monday, October 5", or "between Saturday, October 3 and Monday, October 5". */
export function whenLabel(days: string[]): string {
  const sorted = [...new Set(days)].sort();
  if (sorted.length <= 1) return `on ${dayLabel(sorted[0] ?? "")}`;
  return `between ${dayLabel(sorted[0])} and ${dayLabel(sorted[sorted.length - 1])}`;
}

/** Stamps these items as emailed, when nobody has; returns the ones this call stamped. */
async function claimRows(supabase: SupabaseClient, ids: string[], at: string): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase
      .from("pms_change_notices")
      .update({ emailed_at: at })
      .in("id", ids.slice(i, i + 200))
      .is("emailed_at", null)
      .select("id");
    if (error) throw error;
    for (const r of (data ?? []) as { id: unknown }[]) out.push(String(r.id));
  }
  return out;
}

async function releaseRows(supabase: SupabaseClient, ids: string[], at: string): Promise<void> {
  for (let i = 0; i < ids.length; i += 200) {
    await supabase.from("pms_change_notices").update({ emailed_at: null }).in("id", ids.slice(i, i + 200)).eq("emailed_at", at);
  }
}

/** Sends one email to each recipient; how many went out, and why the rest didn't. */
async function sendAll(
  recipients: Recipient[],
  build: (r: Recipient) => Omit<SendEmailInput, "to" | "replyTo">,
  deps: Required<PmsChangeEmailDeps>,
  deadline: number,
): Promise<{ sent: number; failures: string[]; outOfTime: boolean }> {
  let sent = 0;
  const failures: string[] = [];
  for (const r of recipients) {
    // Out of time with nothing sent: stop and hand it back. Once one has gone
    // out the rest follow, since a retry would send that one again.
    if (sent === 0 && deps.clock() >= deadline) return { sent, failures, outOfTime: true };
    try {
      await deps.send({ ...build(r), to: r.email, replyTo: REPLY_TO });
      sent += 1;
    } catch (e) {
      failures.push(errorText(e));
    }
  }
  return { sent, failures, outOfTime: false };
}

type HotelContext = {
  hotelId: string;
  pms: ChangePms;
  hotelName: string;
  timeZone: string;
  currencySymbol: string;
  recipients: Recipient[];
  appUrl: string;
  nowIso: string;
};

/** The warning: something other than MAYA seems to be changing rates. */
async function sendWarning(
  supabase: SupabaseClient,
  ctx: HotelContext,
  rows: NoticeRow[],
  deps: Required<PmsChangeEmailDeps>,
  deadline: number,
): Promise<PmsChangeEmailResult> {
  const base = { hotelId: ctx.hotelId, email: "other_tool" as const };
  const claimed = await claimRows(supabase, rows.map((r) => r.id), ctx.nowIso);
  if (claimed.length === 0) return { ...base, outcome: "not_emailed", reason: "taken" };
  const newest = rows.filter((r) => claimed.includes(r.id)).sort((a, b) => Date.parse(b.found_at) - Date.parse(a.found_at))[0];
  const rates = Math.max(1, Number(newest.rates) || 1);
  const settingsUrl = `${ctx.appUrl}/go/settings.pms?hotel=${encodeURIComponent(ctx.hotelId)}`;
  const { sent, failures, outOfTime } = await sendAll(
    ctx.recipients,
    (r) => {
      const input = { hotelName: ctx.hotelName, pmsType: ctx.pms, rates, settingsUrl, otherProperties: r.otherProperties };
      return {
        subject: otherToolSubject(input),
        html: otherToolHtml(input),
        text: otherToolText(input),
        idempotencyKey: `pms-other-tool:${newest.id}:${r.userId}`,
      };
    },
    deps,
    deadline,
  );
  const late = deps.now() - Date.parse(newest.found_at) > RETRY_FOR_MS;
  if (ctx.recipients.length > 0 && sent === 0 && !late) {
    await releaseRows(supabase, claimed, ctx.nowIso);
    log({ hotelId: ctx.hotelId, email: "other_tool", retry: outOfTime ? "out_of_time" : "all_sends_failed", errors: failures.slice(0, 3) }, "error");
    return { ...base, outcome: "retry", reason: outOfTime ? "out_of_time" : "all_sends_failed", recipients: ctx.recipients.length, sent };
  }
  return finish(supabase, ctx, base, { sent, items: claimed.length, rates, failed: failures.length, outOfTime });
}

/** The day's overwrites, once a day. */
async function sendOverwrites(
  supabase: SupabaseClient,
  ctx: HotelContext,
  today: string,
  rows: NoticeRow[],
  deps: Required<PmsChangeEmailDeps>,
  deadline: number,
): Promise<PmsChangeEmailResult> {
  const base = { hotelId: ctx.hotelId, email: "overwrites" as const };
  // The day, claimed first: at most one of these a day, whatever else runs.
  const { data: watch, error: watchError } = await supabase
    .from("pms_change_watch")
    .select("digest_sent_on")
    .eq("hotel_id", ctx.hotelId)
    .maybeSingle();
  if (watchError) throw watchError;
  const before = (watch as { digest_sent_on?: unknown } | null)?.digest_sent_on ?? null;
  let dayClaimed: boolean;
  if (!watch) {
    const { error } = await supabase.from("pms_change_watch").insert({ hotel_id: ctx.hotelId, digest_sent_on: today, updated_at: ctx.nowIso });
    dayClaimed = !error;
  } else {
    const { data, error } = await supabase
      .from("pms_change_watch")
      .update({ digest_sent_on: today, updated_at: ctx.nowIso })
      .eq("hotel_id", ctx.hotelId)
      .or(`digest_sent_on.is.null,digest_sent_on.lt.${today}`)
      .select("hotel_id");
    if (error) throw error;
    dayClaimed = (data ?? []).length > 0;
  }
  if (!dayClaimed) return { ...base, outcome: "not_emailed", reason: "sent_today" };
  const releaseDay = async () => {
    await supabase.from("pms_change_watch").update({ digest_sent_on: before }).eq("hotel_id", ctx.hotelId).eq("digest_sent_on", today);
  };

  let claimed: string[];
  try {
    claimed = await claimRows(supabase, rows.map((r) => r.id), ctx.nowIso);
  } catch (e) {
    await releaseDay();
    throw e;
  }
  if (claimed.length === 0) {
    await releaseDay();
    return { ...base, outcome: "not_emailed", reason: "taken" };
  }
  const mine = rows.filter((r) => claimed.includes(r.id));

  const { data: roomTypes } = await supabase.from("room_types").select("id, name").eq("hotel_id", ctx.hotelId);
  const names = new Map(((roomTypes ?? []) as { id: unknown; name: unknown }[]).map((r) => [String(r.id), String(r.name)]));
  const lines = overwriteLines(mine, names, ctx.currencySymbol);
  const when = whenLabel(mine.map((r) => hotelDate(r.found_at, ctx.timeZone)));
  const calendarUrl = `${ctx.appUrl}/go/calendar?hotel=${encodeURIComponent(ctx.hotelId)}`;
  const { sent, failures, outOfTime } = await sendAll(
    ctx.recipients,
    (r) => {
      const input = { hotelName: ctx.hotelName, pmsType: ctx.pms, when, lines, calendarUrl, otherProperties: r.otherProperties };
      return {
        subject: overwriteSubject(input),
        html: overwriteHtml(input),
        text: overwriteText(input),
        idempotencyKey: `pms-overwrites:${ctx.hotelId}:${today}:${r.userId}`,
      };
    },
    deps,
    deadline,
  );
  const oldest = Math.min(...mine.map((r) => Date.parse(r.found_at)));
  const late = deps.now() - oldest > RETRY_FOR_MS + 24 * 60 * 60 * 1000;
  if (ctx.recipients.length > 0 && sent === 0 && !late) {
    await releaseRows(supabase, claimed, ctx.nowIso);
    await releaseDay();
    log({ hotelId: ctx.hotelId, email: "overwrites", retry: outOfTime ? "out_of_time" : "all_sends_failed", errors: failures.slice(0, 3) }, "error");
    return { ...base, outcome: "retry", reason: outOfTime ? "out_of_time" : "all_sends_failed", recipients: ctx.recipients.length, sent };
  }
  return finish(supabase, ctx, base, { sent, items: claimed.length, nights: lines.length, failed: failures.length, outOfTime });
}

async function finish(
  supabase: SupabaseClient,
  ctx: HotelContext,
  base: { hotelId: string; email: PmsChangeEmailResult["email"] },
  what: { sent: number; items: number; failed: number; outOfTime: boolean } & Record<string, unknown>,
): Promise<PmsChangeEmailResult> {
  const { sent, items, failed, outOfTime, ...rest } = what;
  const reason =
    ctx.recipients.length === 0
      ? "no_general_manager_or_hotel_admin"
      : sent === 0
        ? outOfTime ? "out_of_time" : "all_sends_failed"
        : failed > 0
          ? "some_sends_failed"
          : undefined;
  log({ hotelId: ctx.hotelId, pmsType: ctx.pms, email: base.email, recipients: ctx.recipients.length, sent, items, ...rest, reason });
  await logEvent(supabase, ctx.hotelId, { pms_type: ctx.pms, email: base.email, recipients: ctx.recipients.length, sent, items, ...(reason ? { reason } : {}) });
  return {
    ...base,
    outcome: sent > 0 ? "emailed" : "not_emailed",
    ...(reason ? { reason } : {}),
    recipients: ctx.recipients.length,
    sent,
    items,
  };
}

async function handleHotel(
  supabase: SupabaseClient,
  hotelId: string,
  pms: ChangePms,
  rows: NoticeRow[],
  deps: Required<PmsChangeEmailDeps>,
  deadline: number,
): Promise<PmsChangeEmailResult[]> {
  const nowIso = new Date(deps.now()).toISOString();
  const { data: hotel, error: hotelError } = await supabase
    .from("hotels")
    .select("id, name, timezone, is_active, currency")
    .eq("id", hotelId)
    .maybeSingle();
  if (hotelError) throw hotelError;
  const h = (hotel ?? {}) as { name?: unknown; timezone?: unknown; is_active?: unknown; currency?: unknown };
  const timeZone = typeof h.timezone === "string" && h.timezone ? h.timezone : "UTC";
  const today = hotelDate(nowIso, timeZone);
  const todayStart = Date.parse(dayStart(today, timeZone));

  const warnings = rows.filter((r) => r.kind === "other_tool");
  // A day's overwrites go out once that day is over at the property.
  const overwrites = rows.filter((r) => r.kind === "overwrite" && Date.parse(r.found_at) < todayStart);
  if (warnings.length === 0 && overwrites.length === 0) return [];

  const due: PmsChangeEmailResult[] = [
    ...(warnings.length > 0 ? [{ hotelId, email: "other_tool" as const }] : []),
    ...(overwrites.length > 0 ? [{ hotelId, email: "overwrites" as const }] : []),
  ].map((b) => ({ ...b, outcome: "not_emailed" as const }));

  // No email is owed to a property that stopped paying, or one that has gone.
  const paid = hotel ? await isPaidLiveHotel(supabase, hotelId, h.is_active as boolean | null) : false;
  if (!paid) {
    await claimRows(supabase, [...warnings, ...overwrites].map((r) => r.id), nowIso);
    log({ hotelId, pmsType: pms, notEmailed: hotel ? "not_paying" : "no_hotel" });
    return due.map((d) => ({ ...d, reason: hotel ? "not_paying" : "no_hotel" }));
  }
  if (!deps.emailConfigured()) {
    log({ hotelId, pmsType: pms, retry: "email_not_configured" });
    return due.map((d) => ({ ...d, outcome: "retry" as const, reason: "email_not_configured" }));
  }

  // The warning says to turn the setting on: not when it is on already.
  let mode = "keep";
  if (warnings.length > 0) {
    const { data: settings, error } = await supabase.from("hotel_settings").select("pms_rate_changes").eq("hotel_id", hotelId).maybeSingle();
    if (error && !isMissingColumnError(error)) throw error;
    mode = (settings as { pms_rate_changes?: unknown } | null)?.pms_rate_changes === "maya_wins" ? "maya_wins" : "keep";
  }

  const ctx: HotelContext = {
    hotelId,
    pms,
    hotelName: typeof h.name === "string" && h.name.trim() ? h.name.trim() : "your property",
    timeZone,
    currencySymbol: emailCurrencySymbol(typeof h.currency === "string" ? h.currency : null),
    recipients: await recipientsFor(supabase, hotelId),
    appUrl: deps.appUrl.replace(/\/+$/, ""),
    nowIso,
  };

  const out: PmsChangeEmailResult[] = [];
  if (warnings.length > 0) {
    if (mode === "maya_wins") {
      await claimRows(supabase, warnings.map((r) => r.id), nowIso);
      log({ hotelId, pmsType: pms, email: "other_tool", notEmailed: "setting_on" });
      out.push({ hotelId, email: "other_tool", outcome: "not_emailed", reason: "setting_on" });
    } else {
      out.push(await sendWarning(supabase, ctx, warnings, deps, deadline));
    }
  }
  if (overwrites.length > 0) out.push(await sendOverwrites(supabase, ctx, today, overwrites, deps, deadline));
  return out;
}

/**
 * Send the emails this PMS's properties are owed. Called once per scheduled
 * fleet invocation; returns what it did, for the invocation's response.
 */
export async function sendDuePmsChangeEmails(
  supabase: SupabaseClient,
  pmsType: ChangePms,
  deps: PmsChangeEmailDeps = {},
): Promise<PmsChangeEmailResult[]> {
  const full: Required<PmsChangeEmailDeps> = {
    now: deps.now ?? Date.now,
    clock: deps.clock ?? Date.now,
    send: deps.send ?? sendEmail,
    emailConfigured: deps.emailConfigured ?? isResendConfigured,
    appUrl: deps.appUrl ?? readEnv("MAYA_APP_URL") ?? DEFAULT_APP_URL,
  };
  const deadline = full.clock() + RUN_BUDGET_MS;
  try {
    // Warnings and overwrites read apart, so a property with thousands of
    // overwrites can never keep another's warning out of the read.
    const unemailed = (kind: string, limit: number) =>
      supabase
        .from("pms_change_notices")
        .select("id, hotel_id, kind, found_at, stay_date, room_type_id, pms_rate, maya_price, rates")
        .eq("pms_type", pmsType)
        .eq("kind", kind)
        .is("emailed_at", null)
        .order("found_at", { ascending: true })
        .limit(limit);
    const [warnings, overwrites] = await Promise.all([unemailed("other_tool", 50), unemailed("overwrite", ROWS_READ)]);
    const error = warnings.error ?? overwrites.error;
    if (error) {
      // Before 99_supabase_migration_pms_rate_changes_v1.sql there is nothing to send.
      if (!isMissingRelationError(error)) log({ pmsType, step: "query", error: error.message }, "error");
      return [];
    }
    const byHotel = new Map<string, NoticeRow[]>();
    for (const r of [...(warnings.data ?? []), ...(overwrites.data ?? [])] as NoticeRow[]) {
      const hotelId = String(r.hotel_id);
      byHotel.set(hotelId, [...(byHotel.get(hotelId) ?? []), { ...r, id: String(r.id), hotel_id: hotelId, found_at: String(r.found_at) }]);
    }
    const results: PmsChangeEmailResult[] = [];
    let hotels = 0;
    for (const [hotelId, rows] of byHotel) {
      if (hotels >= HOTELS_PER_RUN) break;
      if (full.clock() >= deadline) {
        log({ pmsType, step: "run", outOfTime: true });
        break;
      }
      try {
        const done = await handleHotel(supabase, hotelId, pmsType, rows, full, deadline);
        if (done.length > 0) hotels += 1;
        results.push(...done);
      } catch (e) {
        log({ hotelId, pmsType, step: "hotel", error: errorText(e) }, "error");
        results.push({ hotelId, email: "overwrites", outcome: "retry", reason: "unexpected" });
      }
    }
    return results;
  } catch (e) {
    log({ pmsType, step: "run", error: errorText(e) }, "error");
    return [];
  }
}
