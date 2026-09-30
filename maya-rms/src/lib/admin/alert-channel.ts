import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ALERT_CHANNEL_EVENT,
  ALERT_CHANNEL_REPORT_EVERY_MS,
  ALERT_CHANNEL_TEST_EVENT,
} from "../../../supabase/functions/_shared/pms/alerting";
import { ageLabel } from "./pilot-health-assess";

/**
 * What the scheduled sync functions have said about their alert channel, for
 * the Pilot health page.
 *
 * Every real alert is raised inside an edge function, which reads
 * MAYA_ALERT_WEBHOOK from the Supabase function secrets. The app cannot see
 * those, so it does not guess: each function reports its own state to
 * platform_audit_events (alerting.ts recordAlertChannel), a few rows a day,
 * and the test alert's outcome goes there too. This reads the newest of each
 * per function and says, in one line, whether alerts have anywhere to go.
 */

export type AlertChannelState = "ready" | "missing" | "not_https";

export type FunctionAlertReport = {
  fn: string;
  state: AlertChannelState;
  minSeverity: "warn" | "critical";
  reportedAt: string;
};

export type AlertTestRecord = {
  fn: string;
  at: string;
  sent: boolean;
  reason: string | null;
  sentBy: string | null;
};

export type AlertChannelFacts = {
  reports: FunctionAlertReport[];
  lastTest: AlertTestRecord | null;
};

const READ_LIMIT = 60;

/** Read under the caller's session: platform_audit_events is admin-readable. Throws on a failed read. */
export async function loadAlertChannel(ssr: SupabaseClient): Promise<AlertChannelFacts> {
  const { data, error } = await ssr
    .from("platform_audit_events")
    .select("event_type, entity_id, detail, created_at")
    .in("event_type", [ALERT_CHANNEL_EVENT, ALERT_CHANNEL_TEST_EVENT])
    .order("created_at", { ascending: false })
    .limit(READ_LIMIT);
  if (error) throw new Error(`platform_audit_events: ${error.message}`);
  return alertChannelFacts((data ?? []) as AuditRow[]);
}

type AuditRow = { event_type: unknown; entity_id: unknown; detail: unknown; created_at: unknown };

/** The newest report per function and the newest test, out of the rows newest first. */
export function alertChannelFacts(rows: AuditRow[]): AlertChannelFacts {
  const reports = new Map<string, FunctionAlertReport>();
  let lastTest: AlertTestRecord | null = null;
  for (const r of rows) {
    const detail = (r.detail ?? {}) as Record<string, unknown>;
    const fn = String(r.entity_id ?? detail.fn ?? "");
    if (!fn) continue;
    if (r.event_type === ALERT_CHANNEL_EVENT) {
      if (reports.has(fn)) continue;
      const state = detail.state;
      if (state !== "ready" && state !== "missing" && state !== "not_https") continue;
      reports.set(fn, {
        fn,
        state,
        minSeverity: detail.min_severity === "warn" ? "warn" : "critical",
        reportedAt: String(r.created_at),
      });
    } else if (r.event_type === ALERT_CHANNEL_TEST_EVENT && !lastTest) {
      lastTest = {
        fn,
        at: String(r.created_at),
        sent: detail.sent === true,
        reason: typeof detail.reason === "string" ? detail.reason : null,
        sentBy: typeof detail.sent_by === "string" ? detail.sent_by : null,
      };
    }
  }
  return { reports: [...reports.values()].sort((a, b) => a.fn.localeCompare(b.fn)), lastTest };
}

export type AlertChannelLine = {
  /** "ready", "missing", "stale" or "unknown": the one word after "Alerts:". */
  verdict: "ready" | "missing" | "stale" | "unknown";
  severity: "emerald" | "amber" | "rose";
  text: string;
  /** The last test alert, when one is on record. */
  test: string | null;
};

/** A report older than this is not current: two reporting intervals with nothing said. */
export const ALERT_REPORT_STALE_MS = 2 * ALERT_CHANNEL_REPORT_EVERY_MS;

/**
 * One line for the page. "missing" beats everything: one function with
 * nowhere to send is real alerts being skipped. A report nobody has refreshed
 * in two intervals is "stale": the scheduled sync may not be running, which
 * is its own silence.
 */
export function describeAlertChannel(facts: AlertChannelFacts, nowIso: string): AlertChannelLine {
  const ago = (iso: string) => `${ageLabel(iso, nowIso)} ago`;
  const test = facts.lastTest
    ? facts.lastTest.sent
      ? `Last test alert: sent ${ago(facts.lastTest.at)} through ${facts.lastTest.fn}${facts.lastTest.sentBy ? ` for ${facts.lastTest.sentBy}` : ""}.`
      : `Last test alert: not sent ${ago(facts.lastTest.at)} through ${facts.lastTest.fn}${facts.lastTest.reason ? ` (${facts.lastTest.reason})` : ""}.`
    : null;

  if (facts.reports.length === 0) {
    return {
      verdict: "unknown",
      severity: "amber",
      text:
        "Alerts: not reported. No scheduled sync function has said whether its alerts have anywhere to go. " +
        "Deploy the scheduled syncs, or press Send a test alert on the Command Center.",
      test,
    };
  }
  const missing = facts.reports.find((r) => r.state !== "ready");
  if (missing) {
    const why =
      missing.state === "missing"
        ? "MAYA_ALERT_WEBHOOK is not set in the Supabase function secrets"
        : "MAYA_ALERT_WEBHOOK in the Supabase function secrets is not an https:// address";
    return {
      verdict: "missing",
      severity: "rose",
      text: `Alerts: missing. ${missing.fn} said ${ago(missing.reportedAt)} that ${why}, so the alerts it raises are being skipped.`,
      test,
    };
  }
  const newest = facts.reports.reduce((a, b) => (Date.parse(b.reportedAt) > Date.parse(a.reportedAt) ? b : a));
  const stale = Date.parse(nowIso) - Date.parse(newest.reportedAt) > ALERT_REPORT_STALE_MS;
  const floor = newest.minSeverity === "warn" ? "warnings and critical alerts" : "critical alerts only";
  if (stale) {
    return {
      verdict: "stale",
      severity: "amber",
      text: `Alerts: stale. The last word on the alert channel was from ${newest.fn}, ${ago(newest.reportedAt)}: ready, ${floor}. Nothing since, so the scheduled sync may not be running.`,
      test,
    };
  }
  return {
    verdict: "ready",
    severity: "emerald",
    text: `Alerts: ready. ${newest.fn} said ${ago(newest.reportedAt)} that its alerts have somewhere to go (${floor}).`,
    test,
  };
}
