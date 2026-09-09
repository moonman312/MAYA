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

function webhookUrl(): string | null {
  const raw =
    (typeof process !== "undefined" ? process.env?.MAYA_ALERT_WEBHOOK : undefined) ??
    (globalThis as { Deno?: { env?: { get(k: string): string | undefined } } }).Deno?.env?.get(
      "MAYA_ALERT_WEBHOOK",
    );
  return raw && raw.startsWith("https://") ? raw : null;
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
  if (!url) return { sent: false, reason: "no_webhook_configured" };

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

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, severity: alert.severity, key: alert.key, hotelId: alert.hotelId ?? null }),
      signal: AbortSignal.timeout(8000),
    });
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
