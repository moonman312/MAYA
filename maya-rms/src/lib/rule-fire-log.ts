/**
 * A rule's fire log: what sits behind the "12×" in the rules list.
 *
 * A fire is defined once, in SQL (rule_fires in
 * 99_supabase_migration_rule_fire_log_v1.sql): a standard rule's change
 * switched on for a night and room type, or a booking speed or pickup rule's
 * raise or cut, in the last FIRE_LOG_DAYS days. The count in the rules list
 * (rule_fire_counts) and this log (rule_fire_log) both read that one
 * definition, so the count is always the number of rows the log pages
 * through. The 90 days are how long the engine keeps the audit rows that
 * explain a fire (purgeOldAuditRows).
 *
 * Each row is worded like the change log, and by the same rules
 * (src/lib/price-mode.ts): a fire recorded while the property was simulating
 * says what would have happened and that nothing was sent (at the time, once
 * the property is live, with the ledger's word on what going live did with
 * that price while it is still the night's); a live one says it was sent
 * only when the send ledger shows it, and only for the night's latest price;
 * with the mode not known, nothing is claimed about sending.
 * Why it fired uses the change log's own sentences (describeConditions)
 * with the numbers the fire was judged on, or only the numbers when the rule
 * has been edited since, since its marks then are not on record. Nothing is
 * filled in that was not recorded.
 *
 * Pure and client-safe: the route builds the rows, the popup reads the types.
 */

import { describeConditions, type NarrativeMetrics } from "@/lib/changelog-narrative";
import { toNarrativeMetrics } from "@/lib/changelog-route-helpers";
import { afterLiveState, nightSendState, type SendFacts } from "@/lib/changelog-send-lines";
import {
  afterLiveLine,
  modeAt,
  nightLabel,
  pmsSendsPrices,
  priceMoveHeadline,
  sameCents,
  sendLine,
  type ModeTimeline,
  type PriceMode,
  type SendState,
} from "@/lib/price-mode";
import type { RuleCondition } from "@/types/domain";

/** How far back the count and the log reach: the engine's audit retention. */
export const FIRE_LOG_DAYS = 90;
/** Fires per page of the log. */
export const FIRE_LOG_PAGE = 25;
/** The migration that defines a fire; named in the log line a missing function writes. */
export const FIRE_LOG_MIGRATION = "99_supabase_migration_rule_fire_log_v1.sql";

/** One rule_fire_log row, as PostgREST returns it. */
export type FireLogRow = {
  kind: string;
  event_id: string;
  sort_key: string;
  fired_at: string;
  stay_date: string;
  room_type_id: string;
  rule_version: number | null;
  action_kind: string;
  action_direction: string;
  action_value: number | string;
  fire_seq?: number | null;
  metrics?: Record<string, unknown> | null;
  own_numbers?: Record<string, unknown> | null;
  price_before?: number | string | null;
  price_after?: number | string | null;
  clamped_by?: string | null;
  newer_row_at?: string | null;
  ended_at?: string | null;
  ended_reason?: string | null;
  suppressed_at?: string | null;
  stopped_at?: string | null;
};

/** One fire, worded for the log. */
export type RuleFireItem = {
  id: string;
  kind: "ladder" | "pickup";
  fired_at: string;
  /** When it fired, in the property's time with its zone: "Oct 3, 2:05 PM EDT". */
  when: string;
  /** The same, to the second and with the zone, for a hover: "Oct 3, 2026, 2:05:12 PM EDT". */
  when_exact: string;
  stay_date: string;
  /** "Fri Nov 13". */
  night: string;
  room_type: string;
  room_type_id: string;
  /** The rule's adjustment as it fired: "+10%", "-$15". */
  adjustment: string;
  /** The mode at the fire's time: absent when not known. */
  mode?: "simulation" | "live";
  /** The night's price before and after the fire's run, worded for the mode; null when not on record. */
  price_line: string | null;
  /** A floor or ceiling that held the price, worded for the mode. */
  price_note: string | null;
  send_state: "simulated" | SendState | null;
  send_line: string | null;
  /** A simulated fire's price the night still has, on a property live now: what going live did with it. */
  send_after_state?: Exclude<SendState, "not_sent">;
  send_after_line?: string;
  /** Why it fired: the numbers it was judged on, in the change log's words. */
  why: string[];
  /** What happened to it later, oldest first. */
  later: string[];
};

export type RuleFireLogResponse = {
  rule: { id: string; name: string; enabled: boolean };
  /** Fires in the last FIRE_LOG_DAYS days: the rules list's count. Only on the first page. */
  total: number | null;
  days: number;
  fires: RuleFireItem[];
  /** The cursor for the next, older page; null at the end. */
  older: string | null;
};

/** The rule as the log reads it now. */
export type FireLogRule = {
  id: string;
  name: string;
  enabled: boolean;
  version: number;
  condition: RuleCondition | null;
  /** Names of what it measures, when that is not what it changes (measuredRoomTypeNames). */
  measured: string[] | null;
};

export type FireLogContext = {
  rule: FireLogRule;
  roomTypeNames: Map<string, string>;
  currencySymbol: string;
  timezone: string;
  modeTimeline: ModeTimeline;
  pmsType: string | null;
  /** The property is live now (loadLiveNow); null or unset when not known. */
  liveNow?: boolean | null;
  /** The send ledger's reading of the nights asked for; null when it could not be read. */
  sendFacts: SendFacts | null;
  now: Date;
};

/* ── The cursor ─────────────────────────────────────────────────────────── */

/** Where the next page starts: after this fire (its instant, exactly as the database gave it, and its sort key). */
export type FireCursor = { at: string; key: string };

/** Base64url of plain ASCII (instants and ids), the same in the browser and on the server. */
function toBase64Url(text: string): string {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): string {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  return atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
}

export function encodeCursor(c: FireCursor): string {
  return toBase64Url(JSON.stringify([c.at, c.key]));
}

/** The cursor a page handed out, or null when it is not one. */
export function decodeCursor(raw: string | null | undefined): FireCursor | null {
  if (!raw || raw.length > 400) return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
    const parsed = JSON.parse(fromBase64Url(raw)) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [at, key] = parsed as unknown[];
    if (typeof at !== "string" || typeof key !== "string" || key.length > 200) return null;
    if (!Number.isFinite(Date.parse(at))) return null;
    return { at, key };
  } catch {
    return null;
  }
}

/* ── Words ──────────────────────────────────────────────────────────────── */

function money(v: number, sym: string): string {
  return `${sym}${v.toFixed(2)}`;
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** "+10%", "-5%", "+$15", "-$12.50", in the property's currency. */
export function adjustmentLabel(kind: string, direction: string, value: number | string, currencySymbol: string): string {
  const v = Number(value);
  const sign = direction === "decrease" ? "-" : "+";
  if (kind === "fixed") return `${sign}${currencySymbol}${Number.isInteger(v) ? v : v.toFixed(2)}`;
  return `${sign}${Math.round(v * 100) / 100}%`;
}

function partsIn(iso: string, timezone: string, opts: Intl.DateTimeFormatOptions): string {
  const at = new Date(iso);
  try {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: timezone }).format(at);
  } catch {
    // An unknown zone name must not take the log down: UTC, and it says so.
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).format(at);
  }
}

function yearIn(iso: string | Date, timezone: string): string {
  const at = typeof iso === "string" ? iso : iso.toISOString();
  return partsIn(at, timezone, { year: "numeric" });
}

/**
 * "Oct 3, 2:05 PM EDT" in the property's time, with its zone so it is never
 * read as the viewer's own clock (the change log shows the viewer's); the
 * year too when it is not this year there.
 */
export function hotelTimeLabel(iso: string, timezone: string, now: Date): string {
  const sameYear = yearIn(iso, timezone) === yearIn(now, timezone);
  return partsIn(iso, timezone, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

/** "Oct 3, 2026, 2:05:12 PM EDT" in the property's time. */
export function hotelTimeExact(iso: string, timezone: string): string {
  return partsIn(iso, timezone, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
}

function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

function listWords(items: string[]): string {
  if (items.length < 2) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Only what was seen, with no mark beside it: for a fire whose rule has been
 * edited since (its marks then are not on record), and for numbers a fire
 * kept on its own row.
 */
export function observedLines(m: NarrativeMetrics | null, measured: string[] | null): string[] {
  if (!m) return [];
  const out: string[] = [];
  if (m.occupancy != null) {
    const who = measured?.length ? `${listWords(measured)} ${measured.length === 1 ? "was" : "were"}` : "It was";
    out.push(`${who} ${pct(m.occupancy)} full.`);
  }
  if (m.dta != null) out.push(`It had ${m.dta === 1 ? "1 day" : `${m.dta} days`} to go.`);
  if (m.pickup_units != null) out.push(`${m.pickup_units} ${m.pickup_units === 1 ? "booking" : "bookings"} arrived in its count.`);
  const bs = m.booking_speed;
  if (bs) {
    const recent = Math.round(bs.recent);
    const seen = recent < 0 ? "more cancelled than booked" : recent === 0 ? "none" : String(recent);
    const usual = bs.expected < 1 ? "where a night like this usually gets almost none" : `against the ${Math.round(bs.expected)} a night like this usually gets`;
    out.push(`Bookings in its count: ${seen}, ${usual}.`);
  }
  return out;
}

/**
 * The numbers a booking speed or pickup fire kept on its own row
 * (pickup_event), for when its run's audit row is not there: what its pickup
 * count found (booked units at the end of the count less at the start) and
 * what its booking speed window counted against the usual. Only the numbers
 * the rule's condition reads.
 */
export function ownNumbersMetrics(own: Record<string, unknown> | null | undefined, condition: RuleCondition | null): NarrativeMetrics | null {
  if (!own) return null;
  const start = num(own.units_start);
  const end = num(own.units_end);
  const bookings = num(own.window_bookings);
  const expected = num(own.window_expected);
  const pickup =
    condition?.pickup_operator && condition.pickup_metric !== "revenue" && start != null && end != null ? end - start : null;
  const speed = bookings != null && expected != null ? { label: "", recent: bookings, expected } : null;
  if (pickup == null && speed == null) return null;
  return { occupancy: null, dta: null, pickup_units: pickup, booking_speed: speed };
}

/** Why the rule fired, from what was recorded. */
export function whyLines(row: FireLogRow, rule: FireLogRule): string[] {
  const edited = row.rule_version != null && Number(row.rule_version) !== rule.version;
  const direction = row.action_direction === "decrease" ? "decrease" : "increase";
  const judged = row.metrics && Object.keys(row.metrics).length > 0 ? toNarrativeMetrics(row.metrics) : null;
  if (judged && !edited && rule.condition) {
    const sentences = describeConditions(rule.condition, judged, rule.measured, direction);
    if (sentences.length > 0) return sentences;
  }
  const seen = observedLines(judged ?? ownNumbersMetrics(row.own_numbers, rule.condition), rule.measured);
  if (edited) return seen.length > 0 ? [...seen, "The rule has been edited since."] : ["The rule has been edited since, and the numbers it fired on aren't on record."];
  if (seen.length > 0) return seen;
  // Nothing recorded but the fire itself: its conditions held, and that is all.
  return rule.condition ? describeConditions(rule.condition, null, rule.measured, direction) : [];
}

const RETIRED: Record<string, string> = {
  bookings_cancelled: "bookings behind it cancelled",
  manual_price: "a price was set by hand",
  rule_edited: "the rule was edited",
};

/** What happened to the fire later, each worded for the mode at its own time. */
export function laterLines(row: FireLogRow, ctx: Pick<FireLogContext, "modeTimeline" | "timezone" | "now">): string[] {
  const events: { at: string; line: string }[] = [];
  const when = (at: string) => hotelTimeLabel(at, ctx.timezone, ctx.now);
  const simulated = (at: string) => modeAt(ctx.modeTimeline, at) === "simulation";
  if (row.ended_at && row.ended_reason !== "night_passed") {
    const at = row.ended_at;
    const would = simulated(at);
    if (row.ended_reason === "replaced") {
      events.push({ at, line: `${would ? "Would have moved" : "Moved"} to the rule's new amount ${when(at)}.` });
    } else {
      const why = row.ended_reason ? RETIRED[row.ended_reason] : undefined;
      events.push({ at, line: `${would ? "Would have come off" : "Came off"} ${when(at)}${why ? `: ${why}` : ""}.` });
    }
  }
  if (row.suppressed_at) events.push({ at: row.suppressed_at, line: `A price set by hand took over ${when(row.suppressed_at)}.` });
  if (row.stopped_at) events.push({ at: row.stopped_at, line: `Told to stop on this night ${when(row.stopped_at)}.` });
  return events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).map((e) => e.line);
}

/**
 * The price line and the floor or ceiling note, worded for the mode: the
 * change log's own bold line ("Queen · stay 2026-11-13: $150.00 up to
 * $165.00 (+10%)", or its simulated sentence), from the night's price before
 * the fire's run to its price after it.
 */
function priceWords(
  row: FireLogRow,
  mode: PriceMode,
  roomType: string,
  sym: string,
): { price_line: string | null; price_note: string | null } {
  const after = num(row.price_after);
  if (after == null) return { price_line: null, price_note: null };
  const before = num(row.price_before);
  const lead = `${roomType} · stay ${row.stay_date.slice(0, 10)}`;
  let line: string;
  if (mode === "simulation") {
    line = priceMoveHeadline({ mode, stayDate: row.stay_date, roomType, from: before ?? after, to: after, changePct: 0, currencySymbol: sym });
  } else if (before == null) {
    line = `${lead}: ${money(after, sym)} after this run.`;
  } else if (sameCents(before, after)) {
    line = `${lead}: stayed at ${money(after, sym)}.`;
  } else {
    const changePct = before > 0 ? Math.round(((after - before) / before) * 1000) / 10 : 0;
    line = priceMoveHeadline({ mode, stayDate: row.stay_date, roomType, from: before, to: after, changePct, currencySymbol: sym });
  }
  const limit = row.clamped_by === "ceiling" ? "ceiling" : row.clamped_by === "floor" ? "floor" : null;
  const note = limit ? `${mode === "simulation" ? "It would have stopped" : "It stopped"} at your ${limit}.` : null;
  return { price_line: line, price_note: note };
}

/** Where the fire's price went, as the change log says it. */
function sendWords(
  row: FireLogRow,
  mode: PriceMode,
  ctx: FireLogContext,
): Pick<RuleFireItem, "send_state" | "send_line" | "send_after_state" | "send_after_line"> {
  if (mode === "simulation") {
    const words = { send_state: "simulated" as const, send_line: sendLine({ mode, state: null, pmsType: ctx.pmsType, liveNow: ctx.liveNow }) };
    // Going live sent the night's price, this one included while it still is the night's.
    const after = num(row.price_after);
    if (ctx.liveNow !== true || after == null || row.newer_row_at || !ctx.sendFacts) return words;
    const state = afterLiveState({ stay_date: row.stay_date, room_type_id: row.room_type_id, price: after }, Date.parse(row.fired_at), ctx.sendFacts);
    const line = afterLiveLine(state, ctx.pmsType);
    return line && state && state !== "not_sent" ? { ...words, send_after_state: state, send_after_line: line } : words;
  }
  if (mode !== "live" || ctx.pmsType == null) return { send_state: null, send_line: null };
  if (!pmsSendsPrices(ctx.pmsType)) {
    return { send_state: "not_sent", send_line: sendLine({ mode, state: "not_sent", pmsType: ctx.pmsType }) };
  }
  // Only the night's latest price is the ledger's to speak for.
  const after = num(row.price_after);
  if (after == null || row.newer_row_at || !ctx.sendFacts) return { send_state: null, send_line: null };
  const state = nightSendState({ stay_date: row.stay_date, room_type_id: row.room_type_id, price: after }, ctx.sendFacts);
  return state ? { send_state: state, send_line: sendLine({ mode, state, pmsType: ctx.pmsType }) } : { send_state: null, send_line: null };
}

/**
 * The nights whose send state the ledger is asked about: fires that are
 * still the night's latest price, live ones, and with `simulatedToo` (the
 * property is live now) simulated ones as well.
 */
export function ledgerCells(
  rows: FireLogRow[],
  modeTimeline: ModeTimeline,
  simulatedToo = false,
): { stay_date: string; room_type_id: string }[] {
  const out = new Map<string, { stay_date: string; room_type_id: string }>();
  for (const r of rows) {
    const mode = modeAt(modeTimeline, r.fired_at);
    const asked = mode === "live" || (simulatedToo && mode === "simulation");
    if (r.newer_row_at || num(r.price_after) == null || !asked) continue;
    const stay = String(r.stay_date).slice(0, 10);
    out.set(`${stay}|${r.room_type_id}`, { stay_date: stay, room_type_id: String(r.room_type_id) });
  }
  return [...out.values()];
}

/** One fire, worded for the log. */
export function buildFireItem(row: FireLogRow, ctx: FireLogContext): RuleFireItem {
  const stayDate = String(row.stay_date).slice(0, 10);
  const roomType = ctx.roomTypeNames.get(String(row.room_type_id)) ?? "A room type no longer here";
  const mode = modeAt(ctx.modeTimeline, row.fired_at);
  const normalised = { ...row, stay_date: stayDate };
  return {
    id: `${row.kind}:${row.event_id}`,
    kind: row.kind === "pickup" ? "pickup" : "ladder",
    fired_at: row.fired_at,
    when: hotelTimeLabel(row.fired_at, ctx.timezone, ctx.now),
    when_exact: hotelTimeExact(row.fired_at, ctx.timezone),
    stay_date: stayDate,
    night: nightLabel(stayDate),
    room_type: roomType,
    room_type_id: String(row.room_type_id),
    adjustment: adjustmentLabel(row.action_kind, row.action_direction, row.action_value, ctx.currencySymbol),
    ...(mode === "unknown" ? {} : { mode }),
    ...priceWords(normalised, mode, roomType, ctx.currencySymbol),
    ...sendWords(normalised, mode, ctx),
    why: whyLines(normalised, ctx.rule),
    later: laterLines(normalised, ctx),
  };
}
