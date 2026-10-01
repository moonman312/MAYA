import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ALERT_CHANNEL_EVENT } from "../../../supabase/functions/_shared/pms/alerting";

/**
 * Whether a property system's sending switch is on, as its scheduled sync
 * last said (audit A25: one switch per system, MAYA_PUSH_RATES_CLOUDBEDS and
 * MAYA_PUSH_RATES_THINK, read only inside the edge functions).
 *
 * The app cannot read function secrets, so it reads what the sync reported:
 * each sending sync writes `sending` and `sending_setting` into its
 * alert.channel row in platform_audit_events (alerting.ts
 * recordAlertChannel), straight away when the switch changes and a few times
 * a day otherwise. Pilot health shows the same report. Owners cannot read
 * that table, so this takes the service role.
 *
 * Null when the system has no sending sync, no sync has said yet, or the
 * read fails; the caller decides what an unknown means
 * (simulation-strip.ts sendingSwitchOn).
 */
const SYNC_FN: Record<string, string> = {
  cloudbeds: "cloudbeds-scheduled-sync",
  think: "think-scheduled-sync",
};

/** How many of the function's newest reports to look through for one that names the switch (a test alert's does not). */
const LOOK_BACK = 10;

export async function loadSendingSwitch(admin: SupabaseClient, pmsType: string | null | undefined): Promise<boolean | null> {
  const fn = pmsType ? SYNC_FN[pmsType] : undefined;
  if (!fn) return null;
  try {
    const { data, error } = await admin
      .from("platform_audit_events")
      .select("detail, created_at")
      .eq("event_type", ALERT_CHANNEL_EVENT)
      .eq("entity_id", fn)
      .order("created_at", { ascending: false })
      .limit(LOOK_BACK);
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as { detail?: { sending?: unknown } | null }[]) {
      if (typeof row.detail?.sending === "boolean") return row.detail.sending;
    }
    return null;
  } catch (e) {
    console.error(JSON.stringify({ fn: "loadSendingSwitch", pmsType, error: e instanceof Error ? e.message : String(e) }));
    return null;
  }
}
