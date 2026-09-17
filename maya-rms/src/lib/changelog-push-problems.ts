/**
 * Rates that are not reaching the PMS, for the change log.
 *
 * Each rate_push_incidents row the owner is meant to see becomes one timeline
 * item: the root cause in plain words (push-failure.ts describePushCause),
 * how many nights and room types it touches, whether it is still going on,
 * and what the owner can do. The tries behind it are condensed so dozens of
 * identical refusals read as one line with a count. Kept free of Supabase so
 * the shaping is unit-testable; the route does the reads.
 *
 * An ongoing problem sits at the top of the change log, above every run: it
 * is the one item that asks the owner to act, and it opened before the runs
 * shown, often hours before. A resolved one sits where it ended, among the
 * runs, and only if it ended within the span of runs shown.
 */

import {
  describePushCause,
  isIncidentSkipReason,
  parseVendorError,
  pmsName,
} from "../../supabase/functions/_shared/pms/push-failure";
import { NO_RATE_TARGET_REASON } from "../../supabase/functions/_shared/pms/push-guardrails";
import type {
  ChangelogCycle,
  ChangelogItem,
  ChangelogPushProblem,
  ChangelogRuleAlertChoice,
  PushProblemRetries,
} from "@/types/domain";

/** Push problems shown at most, newest first. */
export const MAX_PUSH_PROBLEMS = 20;
/** Tries read per problem, newest first. The rest are counted, not listed. */
export const MAX_TRIES_READ = 100;

export type IncidentForLog = {
  id: string;
  pms_type: string;
  cause: string;
  opened_at: string;
  attempt_count: number;
  attempts_stored: number;
  resolved_at: string | null;
  resolution: string | null;
};

export type IncidentCellForLog = {
  incident_id: string;
  room_type_id: string;
  stay_date: string;
  /** open, landed, superseded or stopped. */
  state?: string;
};

export type IncidentAttemptForLog = {
  incident_id: string;
  attempted_at: string;
  stay_date: string;
  room_type_id: string;
  phase: string;
  outcome: string;
  http_status: number | null;
  message: string | null;
};

const OUTCOMES = new Set(["failed", "rejected", "skipped", "unconfirmed", "landed"]);

function outcomeLabel(outcome: PushProblemRetries["outcome"], pms: string, message: string | null, cause?: string): string {
  const name = pmsName(pms);
  switch (outcome) {
    case "failed":
      return `${name} refused them`;
    case "rejected":
      return `${name} accepted them, then rejected them`;
    case "unconfirmed":
      return `${name} never confirmed them`;
    case "skipped":
      // Never sent: there was no rate in the PMS to send to, which is the
      // problem itself, not MAYA choosing to wait.
      if (message === NO_RATE_TARGET_REASON) {
        return cause === "pms_unavailable" ? `Couldn't read the rates in ${name}` : `Nothing to send to in ${name}`;
      }
      return "MAYA held them back";
    case "landed":
      return "Went through";
  }
}

/**
 * Tries that went the same way (same outcome, status and message) as one line
 * each: when, how many, over how many nights. Oldest line first.
 */
export function condenseRetries(attempts: IncidentAttemptForLog[], pms: string, cause?: string): PushProblemRetries[] {
  const groups = new Map<
    string,
    { line: PushProblemRetries; nights: Set<string>; roomTypes: Set<string> }
  >();
  for (const a of attempts) {
    const outcome = (OUTCOMES.has(a.outcome) ? a.outcome : "failed") as PushProblemRetries["outcome"];
    const key = `${outcome}|${a.phase}|${a.http_status ?? ""}|${a.message ?? ""}`;
    let g = groups.get(key);
    if (!g) {
      // A skip's message is MAYA's reason code, which means nothing to an owner.
      const text = a.message && !isIncidentSkipReason(a.message) ? parseVendorError(a.message).text.trim() : "";
      g = {
        line: {
          first_at: a.attempted_at,
          last_at: a.attempted_at,
          count: 0,
          nights: 0,
          room_types: 0,
          outcome,
          label: outcomeLabel(outcome, pms, a.message, cause),
          detail: text || null,
        },
        nights: new Set(),
        roomTypes: new Set(),
      };
      groups.set(key, g);
    }
    g.line.count += 1;
    if (a.attempted_at < g.line.first_at) g.line.first_at = a.attempted_at;
    if (a.attempted_at > g.line.last_at) g.line.last_at = a.attempted_at;
    g.nights.add(a.stay_date);
    g.roomTypes.add(a.room_type_id);
  }
  return [...groups.values()]
    .map((g) => ({ ...g.line, nights: g.nights.size, room_types: g.roomTypes.size }))
    .sort((a, b) => (a.first_at < b.first_at ? -1 : a.first_at > b.first_at ? 1 : 0));
}

export function buildPushProblems(
  incidents: IncidentForLog[],
  cells: IncidentCellForLog[],
  attempts: IncidentAttemptForLog[],
  roomTypeNames: Map<string, string>,
): ChangelogPushProblem[] {
  return incidents.map((incident) => {
    const resolved = incident.resolved_at != null;
    const all = cells.filter((c) => c.incident_id === incident.id);
    // While it lasts, what it affects now: nights that landed or are over
    // since are not part of it any more. Once over, everything it touched.
    const open = all.filter((c) => c.state === "open");
    const own = resolved || open.length === 0 ? all : open;
    const roomTypeIds = [...new Set(own.map((c) => c.room_type_id))];
    const names = roomTypeIds.map((id) => roomTypeNames.get(id)).filter((n): n is string => !!n);
    const { title, action } = describePushCause(incident.cause, incident.pms_type, names);
    const tries = attempts.filter((a) => a.incident_id === incident.id);
    return {
      kind: "push_problem" as const,
      id: incident.id,
      timestamp: incident.opened_at,
      pms: pmsName(incident.pms_type),
      cause: incident.cause,
      title,
      action: resolved ? null : action,
      nights: new Set(own.map((c) => c.stay_date)).size,
      room_types: names,
      status: resolved ? ("resolved" as const) : ("ongoing" as const),
      resolved_at: incident.resolved_at,
      resolution: (incident.resolution as ChangelogPushProblem["resolution"]) ?? null,
      attempts: incident.attempt_count,
      retries: condenseRetries(tries, incident.pms_type, incident.cause),
      retries_not_kept: Math.max(0, incident.attempt_count - tries.length),
    };
  });
}

/**
 * Pricing runs, push problems and the owner's own answers in one timeline.
 * Ongoing problems first, newest opened first; then the runs, the resolved
 * problems and the answers newest first, each where it happened. Anything
 * that ended before the oldest run shown is left out: it belongs to history
 * the log isn't showing.
 */
export function mergeTimeline(
  cycles: ChangelogCycle[],
  problems: ChangelogPushProblem[],
  answers: ChangelogRuleAlertChoice[] = [],
): ChangelogItem[] {
  const newestFirst = <T>(list: { item: T; at: number }[]) =>
    list
      .map((x, i) => ({ ...x, i }))
      .sort((a, b) => (b.at || 0) - (a.at || 0) || a.i - b.i)
      .map((x) => x.item);
  const ongoing = problems.filter((p) => p.status === "ongoing");
  const oldestRun = cycles.length > 0 ? Math.min(...cycles.map((c) => Date.parse(c.timestamp) || 0)) : -Infinity;
  const ended = problems
    .filter((p) => p.status !== "ongoing")
    .map((p) => ({ item: p as ChangelogItem, at: Date.parse(p.resolved_at ?? p.timestamp) }))
    .filter((x) => !(x.at < oldestRun));
  const answered = answers
    .map((a) => ({ item: a as ChangelogItem, at: Date.parse(a.timestamp) }))
    .filter((x) => !(x.at < oldestRun));
  return [
    ...newestFirst(ongoing.map((p) => ({ item: p as ChangelogItem, at: Date.parse(p.timestamp) }))),
    ...newestFirst([
      ...cycles.map((c) => ({ item: c as ChangelogItem, at: Date.parse(c.timestamp) })),
      ...ended,
      ...answered,
    ]),
  ];
}

/** The oldest run a set of cycles shows, as an ISO instant; null with none. */
export function oldestShownRun(cycles: ChangelogCycle[]): string | null {
  let oldest: string | null = null;
  for (const c of cycles) if (!oldest || Date.parse(c.timestamp) < Date.parse(oldest)) oldest = c.timestamp;
  return oldest;
}
