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
 * connection email. The cost is a few reads on a partial index (items not
 * emailed yet) that is empty nearly all the time.
 *
 * Properties first, not rows: the run finds each property with overwrites
 * not emailed yet (one small read per property, oldest waiting first), so a
 * property with thousands of overwrites never keeps another's email out of
 * the run. A property whose day isn't over, or whose email for the day went
 * already, costs a read and doesn't count toward HOTELS_PER_RUN.
 *
 * Exactly once: the items are stamped (emailed_at) in a conditional update
 * before anything is sent; for the overwrites, every one found before the
 * property's day began, in one update, and the email is built from what that
 * update stamped. When every email then fails, the stamps are handed back
 * and a later run tries again, for RETRY_FOR_MS. A property that stopped
 * paying gets no email, and its items are stamped all the same. While email
 * isn't set up (no Resend secrets) nothing is stamped, so the first run
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
/** Properties with overwrites waiting one invocation looks at, at most. */
export const HOTELS_SCANNED = 200;
/** Warnings read per invocation (at most one a week per property, so few). */
const WARNINGS_READ = 50;
/** Rows per page when reading back the overwrites an email covers. */
const PAGE = 1000;
const NOTICE_COLUMNS = "id, hotel_id, kind, found_at, stay_date, room_type_id, pms_rate, maya_price, rates";

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

/**
 * Each property with overwrites not emailed yet, and when its oldest was
 * found: one read per property, walking the properties in id order, so
 * however many rows one property has, every other one is found too.
 */
async function hotelsWithOverwrites(supabase: SupabaseClient, pmsType: ChangePms): Promise<{ hotelId: string; oldest: string }[]> {
  const out: { hotelId: string; oldest: string }[] = [];
  let after: string | null = null;
  while (out.length < HOTELS_SCANNED) {
    let q = supabase
      .from("pms_change_notices")
      .select("hotel_id, found_at")
      .eq("pms_type", pmsType)
      .eq("kind", "overwrite")
      .is("emailed_at", null);
    if (after !== null) q = q.gt("hotel_id", after);
    const { data, error } = await q.order("hotel_id", { ascending: true }).order("found_at", { ascending: true }).limit(1);
    if (error) throw error;
    const row = ((data ?? []) as { hotel_id: unknown; found_at: unknown }[])[0];
    if (!row) break;
    after = String(row.hotel_id);
    out.push({ hotelId: after, oldest: String(row.found_at) });
  }
  return out;
}

/** The property's overwrites found before its day began and not emailed yet: all of them stamped `at`, in one update. */
async function stampDayOverwrites(supabase: SupabaseClient, hotelId: string, pms: ChangePms, dayStartIso: string, at: string): Promise<void> {
  const { error } = await supabase
    .from("pms_change_notices")
    .update({ emailed_at: at })
    .eq("hotel_id", hotelId)
    .eq("pms_type", pms)
    .eq("kind", "overwrite")
    .is("emailed_at", null)
    .lt("found_at", dayStartIso);
  if (error) throw error;
}

/** Every overwrite stamped `at` for the property, read back a page at a time. */
async function stampedOverwrites(supabase: SupabaseClient, hotelId: string, pms: ChangePms, at: string): Promise<NoticeRow[]> {
  const out: NoticeRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("pms_change_notices")
      .select(NOTICE_COLUMNS)
      .eq("hotel_id", hotelId)
      .eq("pms_type", pms)
      .eq("kind", "overwrite")
      .eq("emailed_at", at)
      .order("found_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const page = (data ?? []) as NoticeRow[];
    for (const r of page) out.push({ ...r, id: String(r.id), hotel_id: String(r.hotel_id), found_at: String(r.found_at) });
    if (page.length < PAGE) return out;
  }
}

async function releaseOverwrites(supabase: SupabaseClient, hotelId: string, pms: ChangePms, at: string): Promise<void> {
  await supabase
    .from("pms_change_notices")
    .update({ emailed_at: null })
    .eq("hotel_id", hotelId)
    .eq("pms_type", pms)
    .eq("kind", "overwrite")
    .eq("emailed_at", at);
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

/** The day's overwrites, once a day: every one found before the property's day began. */
async function sendOverwrites(
  supabase: SupabaseClient,
  ctx: HotelContext,
  today: string,
  todayStartIso: string,
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

  let mine: NoticeRow[];
  try {
    await stampDayOverwrites(supabase, ctx.hotelId, ctx.pms, todayStartIso, ctx.nowIso);
    mine = await stampedOverwrites(supabase, ctx.hotelId, ctx.pms, ctx.nowIso);
  } catch (e) {
    await releaseOverwrites(supabase, ctx.hotelId, ctx.pms, ctx.nowIso).catch(() => {});
    await releaseDay();
    throw e;
  }
  if (mine.length === 0) {
    await releaseDay();
    return { ...base, outcome: "not_emailed", reason: "taken" };
  }

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
    await releaseOverwrites(supabase, ctx.hotelId, ctx.pms, ctx.nowIso);
    await releaseDay();
    log({ hotelId: ctx.hotelId, email: "overwrites", retry: outOfTime ? "out_of_time" : "all_sends_failed", errors: failures.slice(0, 3) }, "error");
    return { ...base, outcome: "retry", reason: outOfTime ? "out_of_time" : "all_sends_failed", recipients: ctx.recipients.length, sent };
  }
  return finish(supabase, ctx, base, { sent, items: mine.length, nights: lines.length, failed: failures.length, outOfTime });
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

type HotelRow = { id: string; name?: unknown; timezone?: unknown; is_active?: unknown; currency?: unknown };

async function handleHotel(
  supabase: SupabaseClient,
  hotelId: string,
  hotel: HotelRow | null,
  pms: ChangePms,
  warnings: NoticeRow[],
  oldestOverwrite: string | null,
  deps: Required<PmsChangeEmailDeps>,
  deadline: number,
): Promise<PmsChangeEmailResult[]> {
  const nowIso = new Date(deps.now()).toISOString();
  const h = hotel ?? ({ id: hotelId } as HotelRow);
  const timeZone = typeof h.timezone === "string" && h.timezone ? h.timezone : "UTC";
  const today = hotelDate(nowIso, timeZone);
  const todayStartIso = dayStart(today, timeZone);

  // A day's overwrites go out once that day is over at the property.
  const overwritesDue = oldestOverwrite !== null && Date.parse(oldestOverwrite) < Date.parse(todayStartIso);
  if (warnings.length === 0 && !overwritesDue) return [];

  const due: PmsChangeEmailResult[] = [
    ...(warnings.length > 0 ? [{ hotelId, email: "other_tool" as const }] : []),
    ...(overwritesDue ? [{ hotelId, email: "overwrites" as const }] : []),
  ].map((b) => ({ ...b, outcome: "not_emailed" as const }));

  // No email is owed to a property that stopped paying, or one that has gone.
  const paid = hotel ? await isPaidLiveHotel(supabase, hotelId, h.is_active as boolean | null) : false;
  if (!paid) {
    await claimRows(supabase, warnings.map((r) => r.id), nowIso);
    if (overwritesDue) await stampDayOverwrites(supabase, hotelId, pms, todayStartIso, nowIso);
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
  if (overwritesDue) out.push(await sendOverwrites(supabase, ctx, today, todayStartIso, deps, deadline));
  return out;
}

/** A result that did nothing but find the day's email gone already: not a property's turn used up. */
function idle(r: PmsChangeEmailResult): boolean {
  return r.outcome === "not_emailed" && (r.reason === "sent_today" || r.reason === "taken");
}

/** The properties' rows, a batch at a time; a property with no row reads as gone. */
async function hotelRows(supabase: SupabaseClient, ids: string[]): Promise<Map<string, HotelRow>> {
  const out = new Map<string, HotelRow>();
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await supabase
      .from("hotels")
      .select("id, name, timezone, is_active, currency")
      .in("id", ids.slice(i, i + 100));
    if (error) throw error;
    for (const r of (data ?? []) as HotelRow[]) out.set(String(r.id), r);
  }
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
    // Warnings and overwrites found apart: warnings are few and read as
    // rows; overwrites by property, so a property with thousands can never
    // keep another's email, or a warning, out of the run.
    const [warningRead, overwriteHotels] = await Promise.all([
      supabase
        .from("pms_change_notices")
        .select(NOTICE_COLUMNS)
        .eq("pms_type", pmsType)
        .eq("kind", "other_tool")
        .is("emailed_at", null)
        .order("found_at", { ascending: true })
        .limit(WARNINGS_READ),
      hotelsWithOverwrites(supabase, pmsType).then(
        (list) => ({ list, error: null }),
        (error: unknown) => ({ list: [] as { hotelId: string; oldest: string }[], error: error as { message?: string } }),
      ),
    ]);
    const error = warningRead.error ?? overwriteHotels.error;
    if (error) {
      // Before 99_supabase_migration_pms_rate_changes_v1.sql there is nothing to send.
      if (!isMissingRelationError(error as { code?: string; message: string })) {
        log({ pmsType, step: "query", error: errorText(error) }, "error");
      }
      return [];
    }
    const warningsByHotel = new Map<string, NoticeRow[]>();
    for (const r of (warningRead.data ?? []) as NoticeRow[]) {
      const hotelId = String(r.hotel_id);
      warningsByHotel.set(hotelId, [...(warningsByHotel.get(hotelId) ?? []), { ...r, id: String(r.id), hotel_id: hotelId, found_at: String(r.found_at) }]);
    }
    const oldestByHotel = new Map(overwriteHotels.list.map((h) => [h.hotelId, h.oldest]));
    // Warnings first, then the properties whose overwrites have waited longest.
    const order = [
      ...warningsByHotel.keys(),
      ...[...overwriteHotels.list].sort((a, b) => Date.parse(a.oldest) - Date.parse(b.oldest)).map((h) => h.hotelId),
    ].filter((id, i, all) => all.indexOf(id) === i);
    if (order.length === 0) return [];
    const hotels = await hotelRows(supabase, order);

    const results: PmsChangeEmailResult[] = [];
    let busy = 0;
    for (const hotelId of order) {
      if (busy >= HOTELS_PER_RUN) break;
      if (full.clock() >= deadline) {
        log({ pmsType, step: "run", outOfTime: true });
        break;
      }
      try {
        const done = await handleHotel(
          supabase,
          hotelId,
          hotels.get(hotelId) ?? null,
          pmsType,
          warningsByHotel.get(hotelId) ?? [],
          oldestByHotel.get(hotelId) ?? null,
          full,
          deadline,
        );
        if (done.some((r) => !idle(r))) busy += 1;
        results.push(...done);
      } catch (e) {
        log({ hotelId, pmsType, step: "hotel", error: errorText(e) }, "error");
        results.push({ hotelId, email: "overwrites", outcome: "retry", reason: "unexpected" });
        busy += 1;
      }
    }
    return results;
  } catch (e) {
    log({ pmsType, step: "run", error: errorText(e) }, "error");
    return [];
  }
}
