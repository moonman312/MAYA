import type { PmsConnectionStatus, PmsType } from "@/lib/admin/types";
import { addCalendarDays, evalIsoToHotelDateString, hotelDayStartIso } from "@/lib/engine/timezone";

/**
 * What the Pilot health page says about one property, worked out from the
 * row platform_pilot_health() gives it (99_supabase_migration_pilot_health_v1.sql,
 * and _v2 for the prices published and not sent).
 *
 * Pure: the clock is an argument, so a test and the page say the same words.
 * No server-only import, so a client component or a test can use it. "Today"
 * is the hotel's date, the day the daily pass counts by.
 */

export type PilotHealthRow = {
  hotel_id: string;
  name: string;
  timezone: string;
  is_test: boolean;
  mode: "live" | "simulation";
  subscription_status: string | null;
  pms_type: PmsType | null;
  pms_status: PmsConnectionStatus | null;
  /** The last successful read from the property system. */
  last_sync_at: string | null;
  down_since: string | null;
  sync_failures: number | null;
  /** The last tick that priced without an error. */
  last_ok_run_at: string | null;
  /** The hotel date the current (or last) daily pass is for. */
  pass_date: string | null;
  /** The next night the pass prices; null once it reached the last one. */
  pass_cursor: string | null;
  pass_started_at: string | null;
  pass_completed_at: string | null;
  pass_horizon_days: number | null;
  /** Nights waiting in the touched-nights queue, and how long the oldest has waited. */
  dirty_count: number;
  dirty_oldest_marked_at: string | null;
  sent_24h: number;
  /** Open sending problems an owner may be told about, and when the oldest opened. */
  open_incidents: number;
  open_incidents_since: string | null;
  /** MAYA's own holds, never shown to owners. */
  open_incidents_admin_only: number;
  open_incident_causes: string[];
  active_rules: number;
  rule_changes_24h: number;
  /**
   * From 99_supabase_migration_pilot_health_v2.sql, so absent on a database
   * that has not run it: nothing is said about them then.
   *
   * Published prices of a Live hotel that have waited over an hour with no
   * sent record at that price, and since when the oldest has waited.
   */
  unsent_count?: number | null;
  unsent_since?: string | null;
  /** Nights held until the hotel's own rates have been read, and when the first was held. */
  rate_read_waiting?: number | null;
  rate_read_waiting_since?: string | null;
  /**
   * From 99_supabase_migration_no_rate_on_record_v1.sql, so absent before it.
   *
   * Room-nights ahead the property system has no rate on record for and
   * nobody typed a price for: not priced, not sent. A rate the property
   * system removed after MAYA sent to the night counts too, unless a price
   * was typed after the removal (99_supabase_migration_signups_feed_v1.sql).
   * Only for a system MAYA reads rates from (Cloudbeds, ThinkReservations).
   * And the last night the property system returned a rate for on its last
   * read (YYYY-MM-DD), null until a read has recorded one.
   */
  no_rate_count?: number | null;
  rates_read_through?: string | null;
};

/** A read older than this is a problem: the overview page's own stale sync line. */
export const STALE_READ_MINUTES = 30;
/**
 * A night waiting longer than this is a problem: the push's freshness limit
 * for a change (MAYA_PUSH_MAX_PRICE_AGE_MINUTES in push-guardrails.ts).
 */
export const QUEUE_WAIT_MINUTES = 30;
/**
 * A daily pass not done this long after the hotel's midnight is a problem
 * rather than a note: what the push counts as stuck (MAYA_PASS_MAX_LAG_MINUTES
 * in pricing-plan.ts).
 */
export const PASS_GRACE_MINUTES = 120;
/**
 * A pass that is running is only worth a look once it has run this long, or
 * nothing has priced without an error for this long. A new pass starts
 * whenever an owner's edit can move a night, at any hour, and a healthy one
 * takes a few ticks.
 */
export const RUNNING_PASS_MINUTES = 30;
/**
 * Nights waiting this long on a read of the hotel's own rates are a problem:
 * when the owner is told too (RATE_READ_VISIBLE_AFTER_MS in push-failure.ts).
 * One failed read is put right by the next, minutes later.
 */
export const RATE_READ_WAIT_MINUTES = 60;
/** The sending problem filed for those nights (push-failure.ts). */
export const RATE_READ_CAUSE = "awaiting_rate_read";

export type ProblemSeverity = "amber" | "rose";
export type ProblemKind = "connection" | "read" | "pass" | "sending" | "unsent" | "rate_read" | "no_rate" | "queue";
export type PropertyProblem = { kind: ProblemKind; severity: ProblemSeverity; text: string };

export type PricedThrough =
  /** Today's pass finished: the last night of its window. */
  | { kind: "done"; date: string }
  /** Today's pass is under way: the night before its cursor, or nothing yet. */
  | { kind: "running"; date: string | null }
  /** Today's pass has not started: the last pass and how far it got. */
  | { kind: "stale"; passDate: string; date: string | null }
  | { kind: "never" };

export type PropertyAssessment = {
  /** The hotel's date. */
  today: string;
  pricedThrough: PricedThrough;
  pricedThroughText: string;
  problems: PropertyProblem[];
  worst: ProblemSeverity | null;
};

/** How long ago, the way the hotel list says it: "under a minute", "5m", "3h", "2d". */
export function ageLabel(iso: string, nowIso: string): string {
  const mins = Math.round((Date.parse(nowIso) - Date.parse(iso)) / 60_000);
  if (mins < 1) return "under a minute";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** A stored cause code as words: rate_not_found is "rate not found". */
export function humaniseCause(cause: string): string {
  return cause.replace(/_/g, " ");
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The last night the pass on record has priced, whichever day it is for. */
function passReach(row: PilotHealthRow): string | null {
  if (!row.pass_date) return null;
  if (row.pass_cursor) return row.pass_cursor > row.pass_date ? addCalendarDays(row.pass_cursor, -1) : null;
  if (row.pass_completed_at) return addCalendarDays(row.pass_date, Math.max(1, row.pass_horizon_days ?? 1) - 1);
  return null;
}

export function pricedThroughOf(row: PilotHealthRow, today: string): PricedThrough {
  if (!row.pass_date) return { kind: "never" };
  const date = passReach(row);
  if (row.pass_date < today) return { kind: "stale", passDate: row.pass_date, date };
  if (row.pass_cursor == null && row.pass_completed_at) return { kind: "done", date: date ?? row.pass_date };
  return { kind: "running", date };
}

export function pricedThroughText(p: PricedThrough): string {
  switch (p.kind) {
    case "done":
      return `Priced through ${p.date}`;
    case "running":
      return p.date ? `Priced through ${p.date} so far, pass running` : "Pass running, nothing priced yet";
    case "stale":
      return p.date
        ? `Not started today; the ${p.passDate} pass priced through ${p.date}`
        : `Not started today; the ${p.passDate} pass priced nothing`;
    case "never":
      return "Never run";
  }
}

export function assessProperty(row: PilotHealthRow, nowIso: string): PropertyAssessment {
  const nowMs = Date.parse(nowIso);
  const today = evalIsoToHotelDateString(nowIso, row.timezone);
  const dayStartIso = hotelDayStartIso(today, row.timezone);
  const minutesIntoDay = (nowMs - Date.parse(dayStartIso)) / 60_000;
  const olderThan = (iso: string | null, minutes: number) => iso != null && nowMs - Date.parse(iso) > minutes * 60_000;
  const problems: PropertyProblem[] = [];

  // The connection itself, and since when.
  if (row.pms_status === "error" || row.pms_status === "disconnected") {
    const state = row.pms_status === "error" ? "in Error" : "Disconnected";
    problems.push({
      kind: "connection",
      severity: "rose",
      text: row.down_since
        ? `The connection has been ${state} for ${ageLabel(row.down_since, nowIso)}.`
        : `The connection is ${state}.`,
    });
  }

  // Reads. A pending connection has nothing to read from yet.
  if (row.pms_status !== "pending") {
    if (!row.pms_status) {
      problems.push({ kind: "read", severity: "rose", text: "No property system is connected, so nothing is read." });
    } else if (!row.last_sync_at) {
      problems.push({ kind: "read", severity: "rose", text: "MAYA has never read from this system." });
    } else if (olderThan(row.last_sync_at, STALE_READ_MINUTES)) {
      problems.push({ kind: "read", severity: "rose", text: `No successful read for ${ageLabel(row.last_sync_at, nowIso)}.` });
    }
  }

  // The daily pass: a note while the hotel day is young, a problem after that.
  const pricedThrough = pricedThroughOf(row, today);
  const passSeverity: ProblemSeverity = minutesIntoDay > PASS_GRACE_MINUTES ? "rose" : "amber";
  const dayAge = ageLabel(dayStartIso, nowIso);
  if (pricedThrough.kind === "never") {
    problems.push({ kind: "pass", severity: "rose", text: "Pricing has never run." });
  } else if (pricedThrough.kind === "stale") {
    const reach = pricedThrough.date ? `priced through ${pricedThrough.date}` : "priced nothing";
    problems.push({
      kind: "pass",
      severity: passSeverity,
      text: `Today's pass has not started, ${dayAge} into the hotel day. The last pass, for ${pricedThrough.passDate}, ${reach}.`,
    });
  } else if (pricedThrough.kind === "running") {
    const slow = row.pass_started_at == null || olderThan(row.pass_started_at, RUNNING_PASS_MINUTES);
    const stalled = row.last_ok_run_at == null || olderThan(row.last_ok_run_at, RUNNING_PASS_MINUTES);
    if (slow || stalled) {
      const started = row.pass_started_at ? `started ${ageLabel(row.pass_started_at, nowIso)} ago and ` : "";
      const reach = pricedThrough.date ? `priced through ${pricedThrough.date} so far` : "has priced nothing yet";
      const lastOk =
        stalled && row.last_ok_run_at ? ` Nothing has priced without an error for ${ageLabel(row.last_ok_run_at, nowIso)}.` : "";
      problems.push({ kind: "pass", severity: passSeverity, text: `Today's pass ${started}is still running, ${reach}.${lastOk}` });
    }
  }

  // Sending: the problems an owner may be told about, by cause. Nights
  // waiting on a rate read have a line of their own below, which waits an
  // hour before it says anything; where the row cannot say how long they
  // have waited (before the v2 migration) they are listed here like the rest.
  const rateReadOnItsOwn = row.rate_read_waiting != null;
  const causes = rateReadOnItsOwn ? row.open_incident_causes.filter((c) => c !== RATE_READ_CAUSE) : row.open_incident_causes;
  const openIncidents = row.open_incidents - (row.open_incident_causes.length - causes.length);
  if (openIncidents > 0) {
    // The oldest on record, which may be the rate read's: said only when it is theirs to say.
    const since =
      row.open_incidents_since && causes.length === row.open_incident_causes.length
        ? ` for ${ageLabel(row.open_incidents_since, nowIso)}`
        : "";
    const named = causes.length ? `: ${causes.map(humaniseCause).join(", ")}` : "";
    problems.push({ kind: "sending", severity: "rose", text: `${plural(openIncidents, "open sending problem")}${since}${named}.` });
  }

  // Nights held until the hotel's own rates have been read.
  const held = row.rate_read_waiting ?? 0;
  if (held > 0 && row.rate_read_waiting_since && olderThan(row.rate_read_waiting_since, RATE_READ_WAIT_MINUTES)) {
    problems.push({
      kind: "rate_read",
      severity: "rose",
      text: `${plural(held, "night")} held for ${ageLabel(row.rate_read_waiting_since, nowIso)} until the hotel's own rates can be read. Nothing is sent to them meanwhile.`,
    });
  }

  // Nights the property system has no rate on record for, removed rates
  // included. Not an outage:
  // a hotel that loads its rates six months out has these all year round.
  // Said as a note, so nobody reads "Looks fine" over nights MAYA cannot
  // price, with how far the rates were last read.
  const noRate = row.no_rate_count ?? 0;
  if (noRate > 0) {
    const through = row.rates_read_through ? ` Rates read through ${row.rates_read_through}.` : "";
    problems.push({
      kind: "no_rate",
      severity: "amber",
      text: `${plural(noRate, "room-night")} ahead with no rate in the property system: not priced and not sent until it has one.${through}`,
    });
  }

  // Published and not sent. The function only counts a Live hotel's prices
  // that have waited over an hour, so any at all is a problem. With nothing
  // sent in a day and nothing on record as wrong, the send step is not
  // running for this hotel: the switch, or the step itself.
  const unsent = row.unsent_count ?? 0;
  if (row.mode === "live" && unsent > 0) {
    const waited = row.unsent_since ? `, the oldest for ${ageLabel(row.unsent_since, nowIso)}` : "";
    const nothingSays = row.sent_24h === 0 && row.open_incidents === 0 && row.open_incidents_admin_only === 0;
    const why = nothingSays
      ? " Nothing was sent in 24h and no sending problem is on record: check MAYA_PUSH_RATES in the function settings, then the push in the sync log."
      : "";
    problems.push({
      kind: "unsent",
      severity: "rose",
      text: `${plural(unsent, "published price")} not sent after over an hour${waited}.${why}`,
    });
  }

  // The queue: a change should be priced well inside the push's freshness limit.
  if (row.dirty_count > 0 && row.dirty_oldest_marked_at && olderThan(row.dirty_oldest_marked_at, QUEUE_WAIT_MINUTES)) {
    problems.push({
      kind: "queue",
      severity: "rose",
      text: `${plural(row.dirty_count, "night")} waiting to be priced, the oldest for ${ageLabel(row.dirty_oldest_marked_at, nowIso)}.`,
    });
  }

  const worst = problems.some((p) => p.severity === "rose") ? "rose" : problems.length ? "amber" : null;
  return { today, pricedThrough, pricedThroughText: pricedThroughText(pricedThrough), problems, worst };
}

/** Properties with a problem first, the worse first, then by name. */
export function compareAssessed(
  a: { row: PilotHealthRow; assessment: PropertyAssessment },
  b: { row: PilotHealthRow; assessment: PropertyAssessment },
): number {
  const rank = (w: ProblemSeverity | null) => (w === "rose" ? 0 : w === "amber" ? 1 : 2);
  return rank(a.assessment.worst) - rank(b.assessment.worst) || a.row.name.localeCompare(b.row.name);
}
