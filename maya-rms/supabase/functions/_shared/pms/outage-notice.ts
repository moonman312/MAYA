/**
 * The email that tells a property its PMS connection is down (G57).
 *
 * Jake's decision (2026-09-27, option A): once a connection has been
 * Disconnected or Error for about an hour, the property's General Manager and
 * Hotel Admin get one email, and the same notice goes to our Slack alert
 * channel. Degraded never counts: MAYA is still reading and sending then. One
 * email per outage; a new outage after the connection comes back may send
 * another.
 *
 * Where it runs: each scheduled sync calls sendDueOutageNotices for its own
 * PMS once per invocation, before claiming hotels. Those crons already tick
 * every five minutes whatever the fleet is doing, and a Disconnected
 * connection is never claimed, so the hotel loop itself would never see it.
 * The cost is one query on a partial index that is empty nearly all the time.
 *
 * What it relies on: pms_connections.down_since and outage_notice_at, kept by
 * the trigger in 99_supabase_migration_connection_outage_notice_v1.sql. Every
 * path that marks a connection down (the syncs, the Cloudbeds uninstall
 * webhook, a refused token refresh, refused Mews keys) gets a start time for
 * free, and coming back clears both.
 *
 * Exactly once: the notice is claimed by a conditional UPDATE before anything
 * is sent, so two invocations running together cannot both send it. If every
 * email then fails for a reason worth retrying, the claim is handed back and
 * the next tick tries again, for up to RETRY_FOR_MS after the notice was due.
 * While email isn't set up (no Resend secrets) the claim is always handed
 * back, so the first tick after they are set sends it; Slack hears about it
 * meanwhile, at most once per six hours (raiseAlert's dedupe).
 *
 * Time: one invocation spends at most about RUN_BUDGET_MS here. Past it, no
 * new notice is started, and a notice with nothing sent yet stops and is
 * handed back, so a hanging Resend cannot eat the sync's budget.
 *
 * Never throws: it runs ahead of the syncs in the same invocation, and a
 * failed email must not cost anyone a sync.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { isPaidLiveHotel } from "../billing/entitlement.ts";
import { isResendConfigured, sendEmail, type SendEmailInput } from "../email/resend.ts";
import { raiseAlert } from "./alerting.ts";
import { outageHtml, outageSubject, outageText, type OutagePms } from "./outage-email.ts";

/** How long a connection is down before anyone is emailed. */
export const OUTAGE_NOTICE_AFTER_MS = 60 * 60 * 1000;
/** A notice whose emails all failed is retried until it is this late. */
export const RETRY_FOR_MS = 6 * 60 * 60 * 1000;
/** Notices one invocation takes on, so a mass outage cannot eat a sync's budget. */
export const NOTICES_PER_RUN = 5;
/** Time one invocation gives the notices before it gets on with the syncs. */
export const RUN_BUDGET_MS = 20_000;
/** Down, for this email. Degraded is left out on purpose. */
export const DOWN_STATUSES = ["disconnected", "error"] as const;
/** Who is emailed: the two roles that can reconnect. */
export const NOTICE_ROLES = ["hotel_admin", "general_manager"] as const;

const REPLY_TO = "info@modern-hospitality-solutions.com";
const DEFAULT_APP_URL = "https://maya-rms.com";

const PMS_LABEL: Record<OutagePms, string> = {
  cloudbeds: "Cloudbeds",
  think: "ThinkReservations",
  mews: "Mews",
};

/** The systems MAYA sends prices to. Mews is read-only. */
const SENDS_PRICES = new Set<OutagePms>(["cloudbeds", "think"]);

function readEnv(name: string): string | undefined {
  const v =
    (typeof process !== "undefined" ? process.env?.[name] : undefined) ??
    (globalThis as { Deno?: { env?: { get(k: string): string | undefined } } }).Deno?.env?.get(name);
  return v && v !== "" ? v : undefined;
}

export type OutageNoticeDeps = {
  now?: () => number;
  /** The wall clock RUN_BUDGET_MS is measured on. Date.now; tests move it. */
  clock?: () => number;
  send?: (input: SendEmailInput) => Promise<{ id: string }>;
  emailConfigured?: () => boolean;
  alert?: typeof raiseAlert;
  /** The app's origin; MAYA_APP_URL, else https://maya-rms.com. */
  appUrl?: string;
};

export type OutageNoticeResult = {
  hotelId: string;
  outcome: "emailed" | "not_emailed" | "retry";
  reason?: string;
  recipients?: number;
  sent?: number;
};

type DueRow = {
  id: string;
  hotel_id: string;
  pms_type: string;
  status: string;
  down_since: string;
};

function log(line: Record<string, unknown>, level: "log" | "error" = "log"): void {
  console[level](JSON.stringify({ fn: "outageNotice", ...line }));
}

/**
 * "14:05 on Tuesday, October 6" in the property's time zone. Built from parts
 * so every runtime's ICU gives the same words; an unknown zone falls back to
 * UTC and says so.
 */
export function formatDownSince(iso: string, timeZone: string | null | undefined): string {
  const at = new Date(iso);
  const build = (tz: string) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(at);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return `${get("hour")}:${get("minute")} on ${get("weekday")}, ${get("month")} ${get("day")}`;
  };
  try {
    return build(timeZone || "UTC");
  } catch {
    return `${build("UTC")} UTC`;
  }
}

async function logEvent(supabase: SupabaseClient, hotelId: string, detail: Record<string, unknown>): Promise<void> {
  try {
    await supabase.rpc("platform_log_event", {
      p_event_type: "pms.outage_notice",
      p_entity_type: "pms_connection",
      p_entity_id: hotelId,
      p_hotel_id: hotelId,
      p_detail: detail,
    });
  } catch {
    // The audit line is a nice-to-have; the console line above it is the record.
  }
}

type Recipient = {
  userId: string;
  email: string;
  /**
   * They can open more than one property. The email's button opens the PMS
   * tab of whichever property they last had open (/go never switches
   * property on a click from outside MAYA), so the email says how to get
   * to this one.
   */
  otherProperties: boolean;
};

/**
 * Who has another property besides this one. A failed read says everyone
 * does: the extra line is harmless, a wrong tab is not.
 */
async function withOtherProperties(
  supabase: SupabaseClient,
  hotelId: string,
  userIds: string[],
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const { data, error } = await supabase
    .from("hotel_memberships")
    .select("user_id, hotel_id")
    .in("user_id", userIds)
    .eq("status", "active");
  if (error) return new Set(userIds);
  const out = new Set<string>();
  for (const r of (data ?? []) as { user_id: unknown; hotel_id: unknown }[]) {
    if (String(r.hotel_id) !== hotelId) out.add(String(r.user_id));
  }
  return out;
}

/** Email addresses of the property's active General Managers and Hotel Admins. */
async function recipientsFor(
  supabase: SupabaseClient,
  hotelId: string,
): Promise<Recipient[]> {
  const { data, error } = await supabase
    .from("hotel_memberships")
    .select("user_id")
    .eq("hotel_id", hotelId)
    .eq("status", "active")
    .in("role", [...NOTICE_ROLES]);
  if (error) throw new Error(`hotel_memberships read failed: ${error.message}`);

  const userIds = [...new Set((data ?? []).map((r) => String((r as { user_id: unknown }).user_id)))];
  const others = await withOtherProperties(supabase, hotelId, userIds);
  const out: Recipient[] = [];
  for (const userId of userIds) {
    const { data: u, error: uErr } = await supabase.auth.admin.getUserById(userId);
    if (uErr) throw new Error(`auth user read failed: ${uErr.message}`);
    const email = u?.user?.email?.trim();
    if (email) out.push({ userId, email, otherProperties: others.has(userId) });
  }
  return out;
}

async function handleOne(
  supabase: SupabaseClient,
  row: DueRow,
  deps: Required<OutageNoticeDeps>,
  deadline: number,
): Promise<OutageNoticeResult> {
  const hotelId = row.hotel_id;
  const pms = row.pms_type as OutagePms;
  const now = deps.now();
  const nowIso = new Date(now).toISOString();
  const cutoffIso = new Date(now - OUTAGE_NOTICE_AFTER_MS).toISOString();

  // Claim it. The conditions are the query's own, re-checked in the same
  // statement: a connection that came back (or went down again seconds ago)
  // since the read is left alone.
  const { data: claimed, error: claimErr } = await supabase
    .from("pms_connections")
    .update({ outage_notice_at: nowIso })
    .eq("id", row.id)
    .is("outage_notice_at", null)
    .in("status", [...DOWN_STATUSES])
    .lte("down_since", cutoffIso)
    .select("id");
  if (claimErr) {
    log({ hotelId, step: "claim", error: claimErr.message }, "error");
    return { hotelId, outcome: "retry", reason: "claim_failed" };
  }
  if ((claimed ?? []).length === 0) return { hotelId, outcome: "not_emailed", reason: "taken_or_recovered" };

  const release = async () => {
    await supabase
      .from("pms_connections")
      .update({ outage_notice_at: null })
      .eq("id", row.id)
      .eq("outage_notice_at", nowIso);
  };
  const lateForRetry = now - (Date.parse(row.down_since) + OUTAGE_NOTICE_AFTER_MS) > RETRY_FOR_MS;
  const retryOrGiveUp = async (reason: string): Promise<OutageNoticeResult> => {
    if (lateForRetry) {
      log({ hotelId, pmsType: pms, gaveUp: reason }, "error");
      return { hotelId, outcome: "not_emailed", reason };
    }
    await release();
    return { hotelId, outcome: "retry", reason };
  };

  try {
    const { data: hotel, error: hotelErr } = await supabase
      .from("hotels")
      .select("id, name, timezone, is_active")
      .eq("id", hotelId)
      .maybeSingle();
    if (hotelErr) return await retryOrGiveUp(`hotel_read_failed: ${hotelErr.message}`);
    if (!hotel) return { hotelId, outcome: "not_emailed", reason: "no_hotel" };
    const h = hotel as { name?: unknown; timezone?: unknown; is_active?: unknown };

    // Only a property that is still owed MAYA hears about it. One that stopped
    // paying had its work paused already; "reconnect to get your prices back"
    // would be untrue.
    let paid: boolean;
    try {
      paid = await isPaidLiveHotel(supabase, hotelId, h.is_active as boolean | null);
    } catch (e) {
      return await retryOrGiveUp(e instanceof Error ? e.message : String(e));
    }
    if (!paid) {
      log({ hotelId, pmsType: pms, notEmailed: "not_paying" });
      await logEvent(supabase, hotelId, { pms_type: pms, status: row.status, down_since: row.down_since, reason: "not_paying" });
      return { hotelId, outcome: "not_emailed", reason: "not_paying" };
    }

    const { data: settings } = await supabase
      .from("hotel_settings")
      .select("simulation_mode")
      .eq("hotel_id", hotelId)
      .maybeSingle();
    const live = (settings as { simulation_mode?: unknown } | null)?.simulation_mode === false;

    const hotelName = typeof h.name === "string" && h.name.trim() ? h.name.trim() : "your property";
    const downSince = formatDownSince(row.down_since, typeof h.timezone === "string" ? h.timezone : null);
    const appUrl = deps.appUrl.replace(/\/+$/, "");
    const input = {
      hotelName,
      pmsType: pms,
      status: row.status === "error" ? ("error" as const) : ("disconnected" as const),
      downSince,
      sending: live && SENDS_PRICES.has(pms),
      pmsTabUrl: `${appUrl}/go/pms?hotel=${encodeURIComponent(hotelId)}`,
    };
    const alertKey = `pms_outage_notice:${pms}:${hotelId}:${Date.parse(row.down_since)}`;
    const alertTitle = `${hotelName}: ${PMS_LABEL[pms] ?? pms} connection ${row.status} since ${row.down_since}`;
    const pricesLine = input.sending ? "Live: no prices are going out." : "Not sending prices before this either.";

    // Email isn't set up yet: nothing is sent and nothing is given up. The
    // notice is handed back, so the first tick after the Resend secrets are
    // set emails it. Slack hears now, at most once per six hours, under its
    // own key so the emailed notice still posts when it goes out.
    if (!deps.emailConfigured()) {
      try {
        await deps.alert(supabase, {
          severity: "critical",
          key: `${alertKey}:email_not_configured`,
          title: alertTitle,
          detail:
            "Not emailed yet (email_not_configured): set the RESEND_API_KEY and RESEND_FROM_EMAIL secrets " +
            `and it goes out on the next tick. ${pricesLine}`,
          hotelId,
        });
      } catch (e) {
        log({ hotelId, step: "alert", error: e instanceof Error ? e.message : String(e) }, "error");
      }
      await release();
      log({ hotelId, pmsType: pms, retry: "email_not_configured" });
      return { hotelId, outcome: "retry", reason: "email_not_configured" };
    }

    let recipients: Recipient[];
    try {
      recipients = await recipientsFor(supabase, hotelId);
    } catch (e) {
      return await retryOrGiveUp(e instanceof Error ? e.message : String(e));
    }

    let sent = 0;
    let outOfTime = false;
    const failures: string[] = [];
    const downMs = Date.parse(row.down_since);
    for (const r of recipients) {
      // Out of time with nothing sent: stop and hand it back. Once one has
      // gone out the rest follow, since a retry would send that one again.
      if (sent === 0 && deps.clock() >= deadline) {
        outOfTime = true;
        break;
      }
      const mine = { ...input, otherProperties: r.otherProperties };
      try {
        await deps.send({
          to: r.email,
          subject: outageSubject(mine),
          html: outageHtml(mine),
          text: outageText(mine),
          replyTo: REPLY_TO,
          idempotencyKey: `pms-outage:${row.id}:${downMs}:${r.userId}`,
        });
        sent += 1;
      } catch (e) {
        failures.push(e instanceof Error ? e.message : String(e));
      }
    }
    const nothingSent = outOfTime ? "out_of_time" : "all_sends_failed";

    // Nothing went out: try again on a later tick rather than tell Slack the
    // owner knows when they don't.
    if (recipients.length > 0 && sent === 0 && !lateForRetry) {
      log({ hotelId, pmsType: pms, retry: nothingSent, errors: failures.slice(0, 3) }, "error");
      await release();
      return { hotelId, outcome: "retry", reason: nothingSent, recipients: recipients.length, sent };
    }

    const reason =
      recipients.length === 0
        ? "no_general_manager_or_hotel_admin"
        : sent === 0
          ? nothingSent
          : sent < recipients.length
            ? "some_sends_failed"
            : undefined;

    // From here on the emails have gone out, so nothing may hand the notice
    // back: a retry would send them again.
    try {
      await deps.alert(supabase, {
        severity: "critical",
        key: alertKey,
        title: alertTitle,
        detail:
          `Emailed ${sent} of ${recipients.length} General Manager / Hotel Admin` +
          (reason ? ` (${reason})` : "") +
          `. ${pricesLine}`,
        hotelId,
      });
    } catch (e) {
      log({ hotelId, step: "alert", error: e instanceof Error ? e.message : String(e) }, "error");
    }

    log({ hotelId, pmsType: pms, status: row.status, recipients: recipients.length, sent, reason });
    await logEvent(supabase, hotelId, {
      pms_type: pms,
      status: row.status,
      down_since: row.down_since,
      recipients: recipients.length,
      sent,
      ...(reason ? { reason } : {}),
    });

    return {
      hotelId,
      outcome: sent > 0 ? "emailed" : "not_emailed",
      ...(reason ? { reason } : {}),
      recipients: recipients.length,
      sent,
    };
  } catch (e) {
    log({ hotelId, step: "notice", error: e instanceof Error ? e.message : String(e) }, "error");
    return await retryOrGiveUp("unexpected");
  }
}

/**
 * Send the notices this PMS's connections are owed. Called once per scheduled
 * invocation; returns what it did, for the invocation's response.
 */
export async function sendDueOutageNotices(
  supabase: SupabaseClient,
  pmsType: OutagePms,
  deps: OutageNoticeDeps = {},
): Promise<OutageNoticeResult[]> {
  const full: Required<OutageNoticeDeps> = {
    now: deps.now ?? Date.now,
    clock: deps.clock ?? Date.now,
    send: deps.send ?? sendEmail,
    emailConfigured: deps.emailConfigured ?? isResendConfigured,
    alert: deps.alert ?? raiseAlert,
    appUrl: deps.appUrl ?? readEnv("MAYA_APP_URL") ?? DEFAULT_APP_URL,
  };

  const deadline = full.clock() + RUN_BUDGET_MS;
  try {
    const cutoffIso = new Date(full.now() - OUTAGE_NOTICE_AFTER_MS).toISOString();
    const { data, error } = await supabase
      .from("pms_connections")
      .select("id, hotel_id, pms_type, status, down_since")
      .eq("pms_type", pmsType)
      .in("status", [...DOWN_STATUSES])
      .is("outage_notice_at", null)
      .lte("down_since", cutoffIso)
      .order("down_since", { ascending: true })
      .limit(NOTICES_PER_RUN);
    if (error) {
      log({ pmsType, step: "query", error: error.message }, "error");
      return [];
    }

    const results: OutageNoticeResult[] = [];
    for (const row of (data ?? []) as DueRow[]) {
      // The rest wait for the next tick, unclaimed.
      if (full.clock() >= deadline) {
        log({ pmsType, step: "run", outOfTime: true, left: (data ?? []).length - results.length });
        break;
      }
      results.push(await handleOne(supabase, row, full, deadline));
    }
    return results;
  } catch (e) {
    log({ pmsType, step: "run", error: e instanceof Error ? e.message : String(e) }, "error");
    return [];
  }
}
