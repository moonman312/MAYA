/**
 * Whether a live price in the change log really went out: the line under
 * each live change ("Sent to Cloudbeds.", "Waiting to be sent to
 * Cloudbeds.", ...) and the wording of MAYA's overwrites of a rate changed in
 * the property system.
 *
 * MAYA's send ledger (rate_updates) keeps one row per night and room type:
 * the newest send and how it went. So it can only speak for the price a night
 * has now. A change is "the night's price now" when its run wrote the night's
 * newest audit row (read from the data, newestAuditAt in
 * changelog-prior-rows.ts, not from what a page happens to show) and
 * published_price still holds its price; for that one the ledger decides,
 * with the push's own reading of a row (decideSendState in
 * lib/pms/send-status.ts, with Try again and a reconnect taken into account).
 * An older change, whose price a later run replaced, gets no line at all: the
 * ledger cannot say whether it went, and the log does not guess. A night
 * already over that was not sent gets none either, since nothing will send it
 * now, and nor does an unsent price the push cannot send at the moment (the
 * property back in simulation, MAYA's work paused, a Disconnected connection,
 * a night past the push window): "waiting" would be untrue.
 *
 * Where nothing is ever sent (a property system MAYA doesn't send prices to,
 * like Mews) every live change says so. Simulated changes already carry
 * "Nothing was sent to ..." from the moment they are built
 * (changelog-route-helpers.ts). Going live sends every night's current price,
 * simulated ones included, so a simulated change that is still the night's
 * price on a property live now gets a second line from the ledger: "Sent to
 * Cloudbeds after you went live.", waiting, or couldn't be sent.
 */

import { isEntitledStatus } from "@/lib/billing/entitlement";
import { isMissingColumnError } from "@/lib/engine/snapshots";
import { hotelPricingHorizon } from "@/lib/pms/pricing-horizon";
import { lastNightOf } from "@/lib/pms/pricing-window";
import { decideSendState, readConnections, sendingConnection, type LedgerCell } from "@/lib/pms/send-status";
import { afterLiveLine, pmsSendsPrices, sameCents, sendLine, type SendState } from "@/lib/price-mode";
import type { ChangelogCycle, ChangelogEntry, ChangelogItem } from "@/types/domain";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SEND_IN_PROGRESS_MESSAGE } from "../../supabase/functions/_shared/pms/push-failure";

/** What the ledger and the calendar say, keyed by `stay_date|room_type_id`. */
export type SendFacts = {
  /** The property system prices go to, or would: null with no connection at all. */
  pmsType: string | null;
  ledger: Map<string, LedgerCell>;
  published: Map<string, number>;
  /** The property's date today (YYYY-MM-DD): an earlier night is over. */
  today: string;
  nowMs: number;
  /** When the connection was last authorised again, which lets a held failure go once more. */
  reauthorizedAtMs?: number;
  /** The property is live now. A simulated price gets a second line only then. */
  liveNow?: boolean;
  /**
   * Whether the push sends anything for the property now: live, MAYA's work
   * not paused over the subscription, and a connection to a system MAYA sends
   * to that is not Disconnected (the gates readSendStatus reads). False means
   * an unsent price is not "waiting". Unset: not read, taken as yes.
   */
  canSend?: boolean;
  /** The last night the push window covers today (YYYY-MM-DD); a later night is not sent yet. */
  lastNight?: string;
};

export function cellKey(stayDate: string, roomTypeId: string): string {
  return `${stayDate.slice(0, 10)}|${roomTypeId}`;
}

function isCycle(item: ChangelogItem): item is ChangelogCycle {
  return !("kind" in item) && Array.isArray((item as ChangelogCycle).changes);
}

/**
 * The nights and room types the ledger is asked about, each once: every live
 * change shown, and with `simulatedToo` (the property is live now, on a
 * system MAYA sends to) every simulated one as well.
 */
export function liveCells(
  items: readonly ChangelogItem[],
  simulatedToo = false,
): { stay_date: string; room_type_id: string }[] {
  const seen = new Map<string, { stay_date: string; room_type_id: string }>();
  for (const item of items) {
    if (!isCycle(item)) continue;
    for (const ch of item.changes) {
      const asked = ch.mode === "live" || (simulatedToo && ch.mode === "simulation");
      if (!asked || !ch.stay_date || !ch.room_type_id) continue;
      const key = cellKey(ch.stay_date, ch.room_type_id);
      if (!seen.has(key)) seen.set(key, { stay_date: ch.stay_date.slice(0, 10), room_type_id: ch.room_type_id });
    }
  }
  return [...seen.values()];
}

/** The ledger's reading of a price the night has now. */
function stateFor(price: number, key: string, stayDate: string, facts: SendFacts): SendState | null {
  const decided = decideSendState({
    ledger: facts.ledger.get(key) ?? null,
    publishedPrice: price,
    pmsType: String(facts.pmsType),
    nowMs: facts.nowMs,
    reauthorizedAtMs: facts.reauthorizedAtMs,
  }).state;
  if (decided === "sent") return "sent";
  const night = stayDate.slice(0, 10);
  // Over, and not sent: nothing will send it now, and "waiting" would be untrue.
  if (night < facts.today) return null;
  if (decided === "failed") return "failed";
  if (decided === "skipped") return "held";
  // Not sent yet, on its way or being tried again: only "waiting" while the
  // push can send it, and once the night is inside the push window.
  if (facts.canSend === false) return null;
  if (facts.lastNight && night > facts.lastNight) return null;
  return "waiting";
}

/**
 * What became of a live price on one night, when it is still the night's
 * price (published_price holds it): sent, waiting, couldn't be sent or held
 * back, by the push's own reading of the ledger. Null when the night's price
 * is another one now (the ledger can't speak for this one), when a night
 * already over was never sent, when an unsent price can't go out at the
 * moment, or where MAYA sends nothing ("not_sent" is the caller's to say for
 * a system like Mews). For the change log's newest change of a night, and a
 * rule's newest fire on it.
 */
export function nightSendState(night: { stay_date: string; room_type_id: string; price: number }, facts: SendFacts): SendState | null {
  if (!pmsSendsPrices(facts.pmsType)) return null;
  const key = cellKey(night.stay_date, night.room_type_id);
  const published = facts.published.get(key);
  if (published == null || !sameCents(published, night.price)) return null;
  return stateFor(night.price, key, night.stay_date, facts);
}

/**
 * What became of a price worked out in simulation at `simulatedAtMs`, which
 * the night still has, now that the property is live: the ledger's reading,
 * as nightSendState gives it, from a send made after that moment (one from
 * before is not about this price). Null while the property is not live, and
 * wherever nightSendState says nothing.
 */
export function afterLiveState(
  night: { stay_date: string; room_type_id: string; price: number },
  simulatedAtMs: number,
  facts: SendFacts,
): SendState | null {
  if (facts.liveNow !== true) return null;
  const state = nightSendState(night, facts);
  if (state == null || state === "waiting") return state;
  const row = facts.ledger.get(cellKey(night.stay_date, night.room_type_id));
  return row && Number.isFinite(row.pushedAtMs) && row.pushedAtMs > simulatedAtMs ? state : null;
}

/**
 * Each change's sending line, newest run first: `items` as the route merged
 * them. `newestAt` is when each night's newest audit row was written, keyed
 * `stay_date|room_type_id` (newestAuditAt): only the change its run wrote
 * speaks for the night's price, whatever page it is on and whether or not
 * it is one of a run's shown changes. Null when that could not be read: then
 * no change claims anything from the ledger.
 *
 * A live change gets the ledger's reading. A simulated one keeps its
 * "Nothing was sent" line, and on a property live now gets afterLiveLine's
 * second line. Changes whose mode is not known are returned as they are.
 */
export function attachSendLines<T extends ChangelogItem>(
  items: T[],
  facts: SendFacts,
  newestAt: ReadonlyMap<string, number> | null,
): T[] {
  const sends = pmsSendsPrices(facts.pmsType);
  const isNewest = (ch: ChangelogEntry, runAt: string) => {
    if (!newestAt || !ch.stay_date || !ch.room_type_id) return false;
    const at = newestAt.get(cellKey(ch.stay_date, ch.room_type_id));
    return at != null && at === Date.parse(runAt);
  };
  const line = (ch: ChangelogEntry, runAt: string): ChangelogEntry => {
    if (ch.mode === "simulation") {
      if (!sends || facts.liveNow !== true || !isNewest(ch, runAt)) return ch;
      const state = afterLiveState({ stay_date: ch.stay_date!, room_type_id: ch.room_type_id!, price: ch.new_rate }, Date.parse(runAt), facts);
      const after = afterLiveLine(state, facts.pmsType);
      if (!after || state == null || state === "not_sent") return ch;
      return { ...ch, send_after_state: state, send_after_line: after };
    }
    if (ch.mode !== "live" || facts.pmsType == null) return ch;
    if (!sends) {
      return { ...ch, send_state: "not_sent", send_line: sendLine({ mode: "live", state: "not_sent", pmsType: facts.pmsType }) ?? undefined };
    }
    // Only the change that wrote the night's newest row speaks for its price now.
    if (!isNewest(ch, runAt)) return ch;
    const state = nightSendState({ stay_date: ch.stay_date!, room_type_id: ch.room_type_id!, price: ch.new_rate }, facts);
    if (state == null) return ch;
    return { ...ch, send_state: state, send_line: sendLine({ mode: "live", state, pmsType: facts.pmsType }) ?? undefined };
  };
  return items.map((item) =>
    isCycle(item) ? ({ ...item, changes: item.changes.map((ch) => line(ch, item.timestamp)) } as T) : item,
  );
}

/**
 * What became of MAYA's price over a rate changed in the property system
 * (a pms_change_notices overwrite, written when the refresh decides to send
 * it again, before the push does): "sent" once the ledger holds a send at
 * that price made at or after the notice; for the newest notice of a night
 * whose price is still MAYA's, the ledger's reading of it; otherwise null,
 * when the ledger no longer speaks for it.
 */
export function overwriteSendState(
  notice: { stay_date: string; room_type_id: string; maya_price: number; found_at: string },
  newestForNight: boolean,
  facts: SendFacts,
): SendState | null {
  if (!pmsSendsPrices(facts.pmsType)) return null;
  const key = cellKey(notice.stay_date, notice.room_type_id);
  const ledger = facts.ledger.get(key);
  const foundMs = Date.parse(notice.found_at);
  if (
    ledger &&
    ledger.status === "sent" &&
    sameCents(ledger.price, notice.maya_price) &&
    Number.isFinite(ledger.pushedAtMs) &&
    ledger.pushedAtMs >= foundMs
  ) {
    return "sent";
  }
  const published = facts.published.get(key);
  if (!newestForNight || published == null || !sameCents(published, notice.maya_price)) return null;
  const state = stateFor(notice.maya_price, key, notice.stay_date, facts);
  // A send at this price before the notice is the one the PMS changed: not this one.
  return state === "sent" ? null : state;
}

/* ── The reads ─────────────────────────────────────────────────────────── */

const LEDGER_COLUMNS = "room_type_id, stay_date, status, price, error, attempts, pms_job_reference, pushed_at";
/** Nights per read: PostgREST answers 1,000 rows at most, and one room type has one row per night. */
const DATES_PER_READ = 500;

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** One read per room type and chunk of nights, all at once. */
async function readCells(
  admin: SupabaseClient,
  table: "rate_updates" | "published_price",
  columns: string,
  hotelId: string,
  cells: { stay_date: string; room_type_id: string }[],
): Promise<Record<string, unknown>[]> {
  const byType = new Map<string, string[]>();
  for (const c of cells) byType.set(c.room_type_id, [...(byType.get(c.room_type_id) ?? []), c.stay_date]);
  const reads = [...byType].flatMap(([roomTypeId, dates]) =>
    chunks(dates, DATES_PER_READ).map((part) =>
      admin.from(table).select(columns).eq("hotel_id", hotelId).eq("room_type_id", roomTypeId).in("stay_date", part),
    ),
  );
  const out: Record<string, unknown>[] = [];
  for (const { data, error } of await Promise.all(reads)) {
    if (error) throw error;
    out.push(...((data ?? []) as unknown as Record<string, unknown>[]));
  }
  return out;
}

/** The ledger rows, with when Try again was pressed; without it before the manual price retry migration. */
async function readLedgerRows(admin: SupabaseClient, hotelId: string, cells: { stay_date: string; room_type_id: string }[]) {
  try {
    return await readCells(admin, "rate_updates", `${LEDGER_COLUMNS}, retry_requested_at`, hotelId, cells);
  } catch (e) {
    if (!isMissingColumnError(e)) throw e;
    return readCells(admin, "rate_updates", LEDGER_COLUMNS, hotelId, cells);
  }
}

/**
 * The gates the push sends behind, read as readSendStatus reads them: the
 * mode, the subscription, the connection prices go through (and when it was
 * last authorised again), and the push window.
 */
async function readSendGates(
  admin: SupabaseClient,
  hotelId: string,
  today: string,
): Promise<Pick<SendFacts, "liveNow" | "canSend" | "lastNight" | "reauthorizedAtMs">> {
  const [{ data: settings, error: settingsError }, { data: subscription }, connections, horizon] = await Promise.all([
    admin.from("hotel_settings").select("simulation_mode").eq("hotel_id", hotelId).maybeSingle(),
    admin.from("hotel_subscriptions").select("status").eq("hotel_id", hotelId).maybeSingle(),
    readConnections(admin, hotelId),
    hotelPricingHorizon(admin, hotelId),
  ]);
  if (settingsError) throw settingsError;
  const liveNow = (settings as { simulation_mode?: unknown } | null)?.simulation_mode === false;
  const status = (subscription as { status?: unknown } | null)?.status;
  const entitled = status == null || isEntitledStatus(String(status));
  const conn = sendingConnection(connections);
  const reauthorizedAtMs = conn?.reauthorized_at ? Date.parse(String(conn.reauthorized_at)) : NaN;
  return {
    liveNow,
    canSend: liveNow && entitled && conn != null && conn.status !== "disconnected",
    lastNight: lastNightOf(today, horizon),
    reauthorizedAtMs,
  };
}

/**
 * The ledger rows and published prices of these nights, and the gates the
 * push sends behind, read with the service role (rate_updates is a
 * manager's read under RLS; the change log is everyone's) after the caller's
 * access to the property was checked.
 */
export async function readSendFacts(
  admin: SupabaseClient,
  p: { hotelId: string; pmsType: string | null; today: string; now: Date },
  cells: { stay_date: string; room_type_id: string }[],
): Promise<SendFacts> {
  const facts: SendFacts = {
    pmsType: p.pmsType,
    ledger: new Map(),
    published: new Map(),
    today: p.today,
    nowMs: p.now.getTime(),
  };
  if (cells.length === 0 || !pmsSendsPrices(p.pmsType)) return facts;
  const [ledgerRows, publishedRows, gates] = await Promise.all([
    readLedgerRows(admin, p.hotelId, cells),
    readCells(admin, "published_price", "room_type_id, stay_date, price", p.hotelId, cells),
    readSendGates(admin, p.hotelId, p.today),
  ]);
  Object.assign(facts, gates);
  for (const r of ledgerRows) {
    const error = r.error != null ? String(r.error) : null;
    facts.ledger.set(cellKey(String(r.stay_date), String(r.room_type_id)), {
      status: String(r.status),
      price: Number(r.price),
      error,
      // An in-progress marker counts no try of its own (rate-push.ts).
      attempts: error === SEND_IN_PROGRESS_MESSAGE ? Number(r.attempts) || 0 : Number(r.attempts) || 1,
      jobReference: r.pms_job_reference != null ? String(r.pms_job_reference) : null,
      pushedAtMs: r.pushed_at != null ? Date.parse(String(r.pushed_at)) : NaN,
      retryRequestedAtMs: r.retry_requested_at != null ? Date.parse(String(r.retry_requested_at)) : NaN,
    });
  }
  for (const r of publishedRows) {
    if (r.price != null) facts.published.set(cellKey(String(r.stay_date), String(r.room_type_id)), Number(r.price));
  }
  return facts;
}
