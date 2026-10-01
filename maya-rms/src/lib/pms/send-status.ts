/**
 * What became of a typed price after its save: the truth the price editor
 * shows under the box once the save's own line has had its say.
 *
 * The push keeps one ledger row per night and room type (rate_updates), and
 * sends a night only when that row is not a send at the price it would send
 * now. The price it would send is published_price.price for the cell, which
 * the save's own evaluation wrote, so that is what the ledger row is compared
 * with. From the two, the night is in one of six states:
 *
 *   pending    no row at this price yet: the push has not reached it
 *   sending    the row is the in-progress marker a send writes before it goes
 *   sent       a sent row at this price (on Think, accepted; read back later)
 *   retrying   a failed row at this price the push will send again on its own,
 *              with how many sends it has left before it rests
 *   failed     a failed row at this price the push has stopped retrying: its
 *              tries used at this price, or its cause held (push-failure.ts
 *              retryDecision). MAYA still tries once a day; Try again sends it
 *              once more now.
 *   skipped    the push did not send the night: a guardrail held it back
 *              (MAYA's own hold, `skipReason` "maya_hold"), or the room type
 *              has no rate in the property system to send to ("no_rate_target",
 *              which the owner has to fix there and Try again cannot)
 *
 * Where the night is stopped (failed, or skipped for no rate target), the
 * owner is shown why: the open sending problem it is filed under when the
 * change log shows one (`incidentId`), or else the cause itself (`cause`):
 * a quiet cause that used its tries, or a hold like a night that had begun,
 * is only filed where an owner sees it after two hours of failing.
 *
 * The decision is the push's own: the same classification and retryDecision
 * the scheduled tick runs, so the count is never a guess. Not applicable at
 * all where nothing is sent: simulation, a stopped subscription, a system
 * MAYA does not send prices to (Mews), a Disconnected connection, a night
 * that has passed or sits past the push window.
 */

import { isEntitledStatus } from "@/lib/billing/entitlement";
import { isMissingColumnError, isMissingRelationError } from "@/lib/engine/snapshots";
import { hotelPricingHorizon } from "@/lib/pms/pricing-horizon";
import { lastNightOf } from "@/lib/pms/pricing-window";
import { hotelToday } from "@/lib/simulator";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  classifyPushFailure,
  describePushCause,
  MAX_PUSH_ATTEMPTS,
  pmsName,
  retryDecision,
  SEND_IN_PROGRESS_MESSAGE,
} from "../../../supabase/functions/_shared/pms/push-failure";
import { NO_RATE_TARGET_REASON, PMS_RATE_REMOVED_REASON } from "../../../supabase/functions/_shared/pms/push-guardrails";

/**
 * The systems a price is sent to. Mews is read-only for now (G2, on hold), so
 * a Mews property's line stays as it is until sending to Mews is built.
 */
export const SENDS_PRICES = new Set(["cloudbeds", "think"]);

export type SendState = "pending" | "sending" | "sent" | "retrying" | "failed" | "skipped";

/** The failed or sent ledger row for the night, as the decision reads it. */
export type LedgerCell = {
  status: string;
  price: number;
  error: string | null;
  attempts: number;
  jobReference: string | null;
  pushedAtMs: number;
  retryRequestedAtMs: number;
};

export type SendStatus = {
  applicable: boolean;
  state: SendState | null;
  /**
   * Sends the push still makes at this price on its own before it rests:
   * MAX_PUSH_ATTEMPTS less the tries so far for a cause that clears on its
   * own, 1 for a held or rested cell that gets one more, 0 once it has
   * stopped. Null when the night is not failing.
   */
  retriesLeft: number | null;
  attempts: number | null;
  lastAttemptAt: string | null;
  /** True when Try again was pressed after the last try, so the next tick sends once more. */
  retryRequested: boolean;
  pmsType: string | null;
  pmsName: string | null;
  /** The open, customer-visible incident this night is filed under, when there is one. */
  incidentId: string | null;
  /**
   * Why the night is stopped, in the owner's words, when no sending problem
   * the owner can see says so (incidentId is null). Null otherwise.
   */
  cause: { title: string; action: string | null } | null;
  /** For a skipped night: MAYA's own hold, or no rate in the property system to send to. */
  skipReason: "maya_hold" | "no_rate_target" | null;
  maxAttempts: number;
};

const NOT_APPLICABLE: SendStatus = {
  applicable: false,
  state: null,
  retriesLeft: null,
  attempts: null,
  lastAttemptAt: null,
  retryRequested: false,
  pmsType: null,
  pmsName: null,
  incidentId: null,
  cause: null,
  skipReason: null,
  maxAttempts: MAX_PUSH_ATTEMPTS,
};

/** The push's own reading of a failed row's cause (rate-push.ts ledgerFailure). */
function ledgerFailure(pmsType: string, cell: LedgerCell) {
  const job = !!cell.jobReference && !cell.jobReference.startsWith("accepted:");
  return classifyPushFailure({ pms: pmsType, phase: job ? "job" : "send", message: cell.error, attempt: cell.attempts });
}

/**
 * The night's state from its ledger row and the price the push would send.
 * Pure, so the route tests and the editor's copy tests can pin every branch.
 */
export function decideSendState(p: {
  ledger: LedgerCell | null;
  publishedPrice: number | null;
  pmsType: string;
  nowMs: number;
  reauthorizedAtMs?: number;
}): { state: SendState; retriesLeft: number | null; retryRequested: boolean } {
  const { ledger } = p;
  if (!ledger) return { state: "pending", retriesLeft: null, retryRequested: false };
  // Not a hold: the PMS lost MAYA's price there, and the next push sends it again ("MAYA's price wins").
  if (ledger.status === "skipped" && ledger.error === PMS_RATE_REMOVED_REASON) {
    return { state: "pending", retriesLeft: null, retryRequested: false };
  }
  if (ledger.status === "skipped") return { state: "skipped", retriesLeft: null, retryRequested: false };
  if (p.publishedPrice == null || ledger.price !== p.publishedPrice) {
    return { state: "pending", retriesLeft: null, retryRequested: false };
  }
  if (ledger.status === "sent") return { state: "sent", retriesLeft: null, retryRequested: false };
  // The marker a send writes before it goes: on its way, or resent next tick.
  if (ledger.error === SEND_IN_PROGRESS_MESSAGE) return { state: "sending", retriesLeft: null, retryRequested: false };
  const failure = ledgerFailure(p.pmsType, ledger);
  const retryRequested = Number.isFinite(ledger.retryRequestedAtMs) && ledger.retryRequestedAtMs > ledger.pushedAtMs;
  const verdict = retryDecision({
    failure,
    attempts: ledger.attempts,
    lastAttemptAtMs: ledger.pushedAtMs,
    nowMs: p.nowMs,
    reauthorizedAtMs: p.reauthorizedAtMs,
    retryRequestedAtMs: ledger.retryRequestedAtMs,
  });
  if (verdict !== "retry") return { state: "failed", retriesLeft: 0, retryRequested };
  // A held cause, or one that used its tries, gets exactly one more send when
  // it is let through (rested, reconnected or asked for); so does a rate the
  // PMS could not find, whose next failure is held (classifyPushFailure: it
  // is re-read and sent once more, then critical). A cause that clears on its
  // own is sent every tick until its tries run out.
  const oneMore = failure.retry === "hold" || failure.retry === "reresolve" || ledger.attempts >= MAX_PUSH_ATTEMPTS;
  return { state: "retrying", retriesLeft: oneMore ? 1 : MAX_PUSH_ATTEMPTS - ledger.attempts, retryRequested };
}

export type ConnectionRow = { pms_type?: unknown; status?: unknown; reauthorized_at?: unknown };

/** The connection a price goes through: a working one first, then one MAYA keeps trying, then whatever is on file. */
export function sendingConnection(rows: ConnectionRow[]): ConnectionRow | null {
  const sending = rows.filter((r) => SENDS_PRICES.has(String(r.pms_type)));
  return (
    sending.find((r) => r.status === "connected" || r.status === "degraded") ??
    sending.find((r) => r.status === "error") ??
    sending[0] ??
    null
  );
}

export async function readConnections(admin: SupabaseClient, hotelId: string): Promise<ConnectionRow[]> {
  const read = (columns: string) => admin.from("pms_connections").select(columns).eq("hotel_id", hotelId);
  let { data, error } = await read("pms_type, status, reauthorized_at");
  // Before the push guardrails migration: no reconnect to end a hold early.
  if (error && isMissingColumnError(error)) ({ data, error } = await read("pms_type, status"));
  if (error) throw error;
  return (data ?? []) as unknown as ConnectionRow[];
}

const LEDGER_COLUMNS = "status, price, error, attempts, pms_job_reference, pushed_at";

async function readLedgerCell(
  admin: SupabaseClient,
  hotelId: string,
  roomTypeId: string,
  date: string,
): Promise<LedgerCell | null> {
  const read = (columns: string) =>
    admin
      .from("rate_updates")
      .select(columns)
      .eq("hotel_id", hotelId)
      .eq("room_type_id", roomTypeId)
      .eq("stay_date", date)
      .maybeSingle();
  let { data, error } = await read(`${LEDGER_COLUMNS}, retry_requested_at`);
  // Before the manual price retry migration: nobody has pressed Try again.
  if (error && isMissingColumnError(error)) ({ data, error } = await read(LEDGER_COLUMNS));
  if (error) {
    if (isMissingRelationError(error)) return null;
    throw error;
  }
  if (!data) return null;
  const r = data as unknown as Record<string, unknown>;
  const error_ = r.error != null ? String(r.error) : null;
  return {
    status: String(r.status),
    price: Number(r.price),
    error: error_,
    // An in-progress marker counts no try of its own (rate-push.ts).
    attempts: error_ === SEND_IN_PROGRESS_MESSAGE ? Number(r.attempts) || 0 : Number(r.attempts) || 1,
    jobReference: r.pms_job_reference != null ? String(r.pms_job_reference) : null,
    pushedAtMs: r.pushed_at != null ? Date.parse(String(r.pushed_at)) : NaN,
    retryRequestedAtMs: r.retry_requested_at != null ? Date.parse(String(r.retry_requested_at)) : NaN,
  };
}

/**
 * The open sending problems this night is filed under, newest first, that
 * are not MAYA's own holds: the one the owner can see (made customer-visible),
 * if any, and the cause of the newest either way. Nothing before the incident
 * tables exist.
 */
async function openIncidentsFor(
  admin: SupabaseClient,
  hotelId: string,
  roomTypeId: string,
  date: string,
): Promise<{ visibleId: string | null; cause: string | null }> {
  const none = { visibleId: null, cause: null };
  const { data: cells, error: cellsError } = await admin
    .from("rate_push_incident_cells")
    .select("incident_id")
    .eq("hotel_id", hotelId)
    .eq("room_type_id", roomTypeId)
    .eq("stay_date", date);
  if (cellsError) {
    if (isMissingRelationError(cellsError)) return none;
    throw cellsError;
  }
  const ids = [...new Set(((cells ?? []) as { incident_id?: unknown }[]).map((c) => String(c.incident_id)))];
  if (ids.length === 0) return none;
  const { data, error } = await admin
    .from("rate_push_incidents")
    .select("id, cause, customer_visible_at")
    .in("id", ids)
    .eq("admin_only", false)
    .is("resolved_at", null)
    .order("opened_at", { ascending: false });
  if (error) {
    if (isMissingRelationError(error)) return none;
    throw error;
  }
  const rows = (data ?? []) as { id?: unknown; cause?: unknown; customer_visible_at?: unknown }[];
  const visible = rows.find((r) => r.customer_visible_at != null && r.id != null);
  return {
    visibleId: visible ? String(visible.id) : null,
    cause: rows[0]?.cause != null ? String(rows[0].cause) : null,
  };
}

async function roomTypeName(admin: SupabaseClient, roomTypeId: string): Promise<string[]> {
  const { data } = await admin.from("room_types").select("name").eq("id", roomTypeId).maybeSingle();
  const name = (data as { name?: unknown } | null)?.name;
  return typeof name === "string" && name.trim() ? [name] : [];
}

/**
 * The night's send status, read with the service-role client after the
 * caller's access has been checked. `now` is the instant to decide at.
 */
export async function readSendStatus(
  admin: SupabaseClient,
  p: { hotelId: string; roomTypeId: string; date: string; now?: Date },
): Promise<SendStatus> {
  const now = p.now ?? new Date();
  const [{ data: hotel }, { data: settings, error: settingsError }, { data: subscription }, connections, horizon] =
    await Promise.all([
      admin.from("hotels").select("timezone").eq("id", p.hotelId).maybeSingle(),
      admin.from("hotel_settings").select("simulation_mode").eq("hotel_id", p.hotelId).maybeSingle(),
      admin.from("hotel_subscriptions").select("status").eq("hotel_id", p.hotelId).maybeSingle(),
      readConnections(admin, p.hotelId),
      hotelPricingHorizon(admin, p.hotelId),
    ]);
  if (settingsError) throw settingsError;
  // The same gates the scheduled push runs behind, in the order the save
  // reads them: a stopped subscription, simulation, then the connection.
  if (subscription && !isEntitledStatus(String((subscription as { status?: unknown }).status))) return NOT_APPLICABLE;
  if (settings?.simulation_mode !== false) return NOT_APPLICABLE;
  const conn = sendingConnection(connections);
  if (!conn || conn.status === "disconnected") return NOT_APPLICABLE;
  const pmsType = String(conn.pms_type);
  const named = { pmsType, pmsName: pmsName(pmsType) };
  // Only a night the push covers: tonight to the end of the window.
  const today = hotelToday(String(hotel?.timezone ?? "UTC"), now);
  if (p.date < today || p.date > lastNightOf(today, horizon)) return { ...NOT_APPLICABLE, ...named };

  const [ledger, { data: published, error: publishedError }] = await Promise.all([
    readLedgerCell(admin, p.hotelId, p.roomTypeId, p.date),
    admin
      .from("published_price")
      .select("price")
      .eq("hotel_id", p.hotelId)
      .eq("room_type_id", p.roomTypeId)
      .eq("stay_date", p.date)
      .maybeSingle(),
  ]);
  if (publishedError) throw publishedError;
  const publishedPrice = published?.price != null ? Number(published.price) : null;
  const reauthorizedAtMs = conn.reauthorized_at ? Date.parse(String(conn.reauthorized_at)) : NaN;
  const decided = decideSendState({ ledger, publishedPrice, pmsType, nowMs: now.getTime(), reauthorizedAtMs });
  const failing = ledger != null && ledger.status === "failed" && decided.state !== "pending";
  const skipReason =
    decided.state === "skipped" ? (ledger?.error === NO_RATE_TARGET_REASON ? "no_rate_target" : "maya_hold") : null;

  // Stopped where the owner can do something: say where the reason is shown,
  // or the reason itself.
  let incidentId: string | null = null;
  let cause: SendStatus["cause"] = null;
  if (ledger && (decided.state === "failed" || skipReason === "no_rate_target")) {
    const open = await openIncidentsFor(admin, p.hotelId, p.roomTypeId, p.date);
    incidentId = open.visibleId;
    if (!incidentId) {
      const code =
        open.cause ??
        (decided.state === "failed"
          ? ledgerFailure(pmsType, ledger).cause
          : classifyPushFailure({ pms: pmsType, phase: "guardrail", message: NO_RATE_TARGET_REASON }).cause);
      cause = describePushCause(code, pmsType, await roomTypeName(admin, p.roomTypeId));
    }
  }
  return {
    applicable: true,
    ...named,
    ...decided,
    attempts: failing ? ledger.attempts : null,
    lastAttemptAt: failing && Number.isFinite(ledger.pushedAtMs) ? new Date(ledger.pushedAtMs).toISOString() : null,
    incidentId,
    cause,
    skipReason,
    maxAttempts: MAX_PUSH_ATTEMPTS,
  };
}
