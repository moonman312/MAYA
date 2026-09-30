/**
 * Outbound alerting — the thing that turns "we record everything" into
 * "someone finds out".
 *
 * MAYA logs every PMS call, classifies connection health, and heartbeats each
 * engine run, but nothing ever looked at any of it unless a human opened the
 * dashboard. A property whose Cloudbeds connection was revoked at 2am stayed
 * broken until someone noticed.
 *
 * Deliberately a plain webhook rather than an SDK: the payload shape below is
 * what Slack and Discord accept directly, and anything else can receive JSON.
 * No new dependency, no vendor account, and it is inert until MAYA_ALERT_WEBHOOK
 * is set — so this ships safely before anyone has decided where alerts go.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type AlertSeverity = "warn" | "critical";

export type Alert = {
  severity: AlertSeverity;
  /** Stable identity for the condition, so the same problem can be deduped. */
  key: string;
  title: string;
  detail?: string;
  hotelId?: string;
};

/** Don't re-alert the same condition more often than this. */
const DEDUPE_WINDOW_MS = 6 * 60 * 60 * 1000;

function readEnv(name: string): string | undefined {
  return (
    (typeof process !== "undefined" ? process.env?.[name] : undefined) ??
    (globalThis as { Deno?: { env?: { get(k: string): string | undefined } } }).Deno?.env?.get(name)
  );
}

function webhookUrl(): string | null {
  const raw = readEnv("MAYA_ALERT_WEBHOOK");
  return raw && raw.startsWith("https://") ? raw : null;
}

export type AlertChannelState = "ready" | "missing" | "not_https";

/**
 * Whether alerts have somewhere to go, without ever handing out the address:
 * "ready", "missing" (MAYA_ALERT_WEBHOOK unset), or "not_https" (set, but
 * alerts are never sent in cleartext, so it is ignored).
 *
 * The answer is about THIS process's settings. The app and the edge
 * functions each read their own, so the app's answer says nothing about
 * whether a real alert, raised inside a scheduled sync, has anywhere to go.
 * That is why the edge functions report theirs (recordAlertChannel) and the
 * test alert is sent from an edge function, not the app.
 */
export function alertChannelState(): AlertChannelState {
  const raw = readEnv("MAYA_ALERT_WEBHOOK");
  if (!raw) return "missing";
  return webhookUrl() ? "ready" : "not_https";
}

/** The floor alerts must reach to be sent: MAYA_ALERT_MIN_SEVERITY, warn or critical (the default). */
export function alertMinSeverity(): AlertSeverity {
  return readEnv("MAYA_ALERT_MIN_SEVERITY")?.toLowerCase() === "warn" ? "warn" : "critical";
}

/** The audit event type an edge function reports its alert channel under. */
export const ALERT_CHANNEL_EVENT = "alert.channel";
/** The audit event type a test alert sent from an edge function is recorded under. */
export const ALERT_CHANNEL_TEST_EVENT = "alert.channel_test";

/** A report is written again after this long even when nothing changed, so a stale one can be told from a current one. */
export const ALERT_CHANNEL_REPORT_EVERY_MS = 6 * 60 * 60 * 1000;

export type AlertChannelReport = {
  state: AlertChannelState;
  minSeverity: AlertSeverity;
};

/** What this process would say about its alert channel. */
export function alertChannelReport(): AlertChannelReport {
  return { state: alertChannelState(), minSeverity: alertMinSeverity() };
}

/**
 * Say, from inside an edge function, whether its alerts have anywhere to go.
 *
 * Written to platform_audit_events as alert.channel, one row per function
 * name, when the state differs from the last report or the last report is
 * older than ALERT_CHANNEL_REPORT_EVERY_MS: a few rows a day, not one per
 * tick. The Pilot health page reads the newest one and shows "alerts: ready"
 * or "alerts: missing" from what the function said, not from the app's own
 * settings. Never throws.
 */
export async function recordAlertChannel(
  supabase: SupabaseClient,
  fn: string,
  opts: { force?: boolean; nowMs?: number } = {},
): Promise<{ recorded: boolean; report: AlertChannelReport }> {
  const report = alertChannelReport();
  try {
    if (!opts.force) {
      const { data: last, error } = await supabase
        .from("platform_audit_events")
        .select("created_at, detail")
        .eq("event_type", ALERT_CHANNEL_EVENT)
        .eq("entity_id", fn)
        .order("created_at", { ascending: false })
        .limit(1);
      if (error) throw new Error(error.message);
      const row = (last ?? [])[0] as { created_at?: unknown; detail?: { state?: unknown; min_severity?: unknown } } | undefined;
      if (row) {
        const ageMs = (opts.nowMs ?? Date.now()) - Date.parse(String(row.created_at));
        const same = row.detail?.state === report.state && row.detail?.min_severity === report.minSeverity;
        // A clock a little ahead of ours still wrote a current report.
        if (same && ageMs < ALERT_CHANNEL_REPORT_EVERY_MS) return { recorded: false, report };
      }
    }
    const { error: logErr } = await supabase.rpc("platform_log_event", {
      p_event_type: ALERT_CHANNEL_EVENT,
      p_entity_type: "alert_channel",
      p_entity_id: fn,
      p_detail: { state: report.state, min_severity: report.minSeverity, fn },
    });
    if (logErr) throw new Error(logErr.message);
    if (report.state !== "ready") {
      console.error(
        JSON.stringify({
          fn,
          step: "alert_channel",
          state: report.state,
          message:
            report.state === "missing"
              ? "MAYA_ALERT_WEBHOOK is not set for this function: no alert it raises can be sent anywhere."
              : "MAYA_ALERT_WEBHOOK is set for this function but is not an https:// address, so no alert it raises is sent.",
        }),
      );
    }
    return { recorded: true, report };
  } catch (e) {
    console.error(JSON.stringify({ fn, step: "alert_channel", error: e instanceof Error ? e.message : String(e) }));
    return { recorded: false, report };
  }
}

export type AlertChannelTest = AlertChannelReport & { sent: boolean; reason?: string };

/**
 * The test alert, sent from inside an edge function so it uses the same
 * settings and the same post as a real alert. No severity floor, no dedupe.
 * The outcome is written to platform_audit_events (alert.channel_test), and
 * the function's channel report is written again with it, so Pilot health
 * shows what this function found. Never throws; never returns the address.
 */
export async function sendAlertChannelTest(
  supabase: SupabaseClient,
  opts: { fn: string; sentBy?: string | null; timeoutMs?: number },
): Promise<AlertChannelTest> {
  const text =
    `🧪 Test alert from the MAYA Command Center, sent through ${opts.fn}${opts.sentBy ? ` by ${opts.sentBy}` : ""}. ` +
    "If you can read this, real alerts from the scheduled syncs reach this channel.";
  const posted = await postTestMessage(text, opts.timeoutMs ?? 8000);
  const { report } = await recordAlertChannel(supabase, opts.fn, { force: true });
  try {
    const { error } = await supabase.rpc("platform_log_event", {
      p_event_type: ALERT_CHANNEL_TEST_EVENT,
      p_entity_type: "alert_channel",
      p_entity_id: opts.fn,
      p_detail: {
        fn: opts.fn,
        sent: posted.sent,
        ...(posted.reason ? { reason: posted.reason } : {}),
        state: report.state,
        min_severity: report.minSeverity,
        ...(opts.sentBy ? { sent_by: opts.sentBy } : {}),
      },
    });
    if (error) throw new Error(error.message);
  } catch (e) {
    console.error(JSON.stringify({ fn: opts.fn, step: "alert_channel_test", error: e instanceof Error ? e.message : String(e) }));
  }
  return { ...report, sent: posted.sent, ...(posted.reason ? { reason: posted.reason } : {}) };
}

function postToWebhook(url: string, payload: Record<string, unknown>, timeoutMs: number): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * One plain message to the alert channel, with no severity floor and no
 * dedupe: for a person checking that alerts arrive (the Command Center's
 * "Send a test alert"). Never throws, and what it returns never includes the
 * webhook address.
 */
export async function postTestMessage(
  text: string,
  timeoutMs = 8000,
): Promise<{ sent: boolean; reason?: string }> {
  const url = webhookUrl();
  if (!url) return { sent: false, reason: "no_webhook_configured" };
  try {
    const res = await postToWebhook(url, { text }, timeoutMs);
    return res.ok ? { sent: true } : { sent: false, reason: `webhook_${res.status}` };
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return { sent: false, reason: timedOut ? "timeout" : "send_failed" };
  }
}

/**
 * Only critical alerts leave the building by default.
 *
 * An alert channel is worth exactly as much as the reader's willingness to look
 * at it, and warnings are what train people to stop looking. Critical means a
 * property is not being priced right now and a human has to act — a revoked
 * connection, not a slow sync. Set MAYA_ALERT_MIN_SEVERITY=warn to widen it.
 */
function severityAllowed(severity: AlertSeverity): boolean {
  return alertMinSeverity() === "warn" ? true : severity === "critical";
}

/**
 * Send an alert, at most once per key per window.
 *
 * Never throws and never blocks the caller's real work: an alerting failure
 * must not turn a degraded sync into a failed one. Deduping is recorded in
 * platform_audit_events, which already exists and is already the audit surface —
 * a dedicated table would be one more thing to purge.
 */
export async function raiseAlert(
  supabase: SupabaseClient,
  alert: Alert,
): Promise<{ sent: boolean; reason?: string }> {
  const url = webhookUrl();
  if (!url) {
    // Said once per alert, so an alert with nowhere to go is at least in the
    // function's log: before this, it was skipped without a word.
    console.error(
      JSON.stringify({
        fn: "raiseAlert",
        key: alert.key,
        severity: alert.severity,
        ...(alert.hotelId ? { hotelId: alert.hotelId } : {}),
        title: alert.title,
        reason: "no_webhook_configured",
        state: alertChannelState(),
        message: "This alert has nowhere to go: MAYA_ALERT_WEBHOOK is not an https:// address in this function's settings.",
      }),
    );
    return { sent: false, reason: "no_webhook_configured" };
  }
  if (!severityAllowed(alert.severity)) return { sent: false, reason: "below_min_severity" };

  try {
    const since = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString();
    const { data: recent } = await supabase
      .from("platform_audit_events")
      .select("id")
      .eq("event_type", "alert.raised")
      .eq("entity_id", alert.key)
      .gte("created_at", since)
      .limit(1);
    if (recent && recent.length > 0) return { sent: false, reason: "deduped" };

    const icon = alert.severity === "critical" ? "🔴" : "🟠";
    const text = [
      `${icon} *MAYA ${alert.severity}* — ${alert.title}`,
      alert.detail ? `> ${alert.detail}` : null,
      alert.hotelId ? `> hotel \`${alert.hotelId}\`` : null,
    ]
      .filter(Boolean)
      .join("\n");

    const res = await postToWebhook(
      url,
      { text, severity: alert.severity, key: alert.key, hotelId: alert.hotelId ?? null },
      8000,
    );
    if (!res.ok) return { sent: false, reason: `webhook_${res.status}` };

    await supabase.rpc("platform_log_event", {
      p_event_type: "alert.raised",
      p_entity_type: "alert",
      p_entity_id: alert.key,
      ...(alert.hotelId ? { p_hotel_id: alert.hotelId } : {}),
      p_detail: { severity: alert.severity, title: alert.title },
    });
    return { sent: true };
  } catch (e) {
    console.error(
      JSON.stringify({
        fn: "raiseAlert",
        key: alert.key,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
    return { sent: false, reason: "send_failed" };
  }
}
