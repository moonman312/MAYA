/**
 * Whether a live price in the change log really went out: the line under
 * each live change ("Sent to Cloudbeds.", "Waiting to be sent to
 * Cloudbeds.", ...) and the wording of MAYA's overwrites of a rate changed in
 * the property system.
 *
 * MAYA's send ledger (rate_updates) keeps one row per night and room type:
 * the newest send and how it went. So it can only speak for the price a night
 * has now. A change is "the night's price now" when it is the newest change
 * the log shows for that night and room type and published_price still holds
 * its price; for that one the ledger decides, with the push's own reading of
 * a row (decideSendState in lib/pms/send-status.ts). An older change, whose
 * price a later one replaced, gets no line at all: the ledger cannot say
 * whether it went, and the log does not guess. A night already over that
 * was not sent gets none either, since nothing will send it now.
 *
 * Where nothing is ever sent (a property system MAYA doesn't send prices to,
 * like Mews) every live change says so. Simulated changes already carry
 * "Nothing was sent to ..." from the moment they are built
 * (changelog-route-helpers.ts), and are left alone here.
 */

import { decideSendState, type LedgerCell } from "@/lib/pms/send-status";
import { pmsSendsPrices, sameCents, sendLine, type SendState } from "@/lib/price-mode";
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
};

export function cellKey(stayDate: string, roomTypeId: string): string {
  return `${stayDate.slice(0, 10)}|${roomTypeId}`;
}

function isCycle(item: ChangelogItem): item is ChangelogCycle {
  return !("kind" in item) && Array.isArray((item as ChangelogCycle).changes);
}

/** The nights and room types of every live change shown, newest run first, each once. */
export function liveCells(items: readonly ChangelogItem[]): { stay_date: string; room_type_id: string }[] {
  const seen = new Map<string, { stay_date: string; room_type_id: string }>();
  for (const item of items) {
    if (!isCycle(item)) continue;
    for (const ch of item.changes) {
      if (ch.mode !== "live" || !ch.stay_date || !ch.room_type_id) continue;
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
  // Over, and not sent: nothing will send it now, and "waiting" would be untrue.
  if (stayDate.slice(0, 10) < facts.today) return null;
  if (decided === "failed") return "failed";
  if (decided === "skipped") return "held";
  return "waiting";
}

/**
 * Each live change's sending line, newest run first: `items` as the route
 * merged them. Simulated changes, and changes whose mode is not known, are
 * returned as they are.
 */
export function attachSendLines<T extends ChangelogItem>(items: T[], facts: SendFacts): T[] {
  const sends = pmsSendsPrices(facts.pmsType);
  const claimed = new Set<string>();
  const line = (ch: ChangelogEntry): ChangelogEntry => {
    if (ch.mode !== "live" || facts.pmsType == null) return ch;
    if (!sends) {
      return { ...ch, send_state: "not_sent", send_line: sendLine({ mode: "live", state: "not_sent", pmsType: facts.pmsType }) ?? undefined };
    }
    if (!ch.stay_date || !ch.room_type_id) return ch;
    const key = cellKey(ch.stay_date, ch.room_type_id);
    // Only the newest change shown for the night speaks for its price now.
    const newest = !claimed.has(key);
    claimed.add(key);
    const published = facts.published.get(key);
    if (!newest || published == null || !sameCents(published, ch.new_rate)) return ch;
    const state = stateFor(ch.new_rate, key, ch.stay_date, facts);
    if (state == null) return ch;
    return { ...ch, send_state: state, send_line: sendLine({ mode: "live", state, pmsType: facts.pmsType }) ?? undefined };
  };
  return items.map((item) => (isCycle(item) ? ({ ...item, changes: item.changes.map(line) } as T) : item));
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

/**
 * The ledger rows and published prices of these nights, read with the
 * service role (rate_updates is a manager's read under RLS; the change log is
 * everyone's) after the caller's access to the property was checked.
 */
export async function readSendFacts(
  admin: SupabaseClient,
  p: { hotelId: string; pmsType: string | null; today: string; now: Date; reauthorizedAtMs?: number },
  cells: { stay_date: string; room_type_id: string }[],
): Promise<SendFacts> {
  const facts: SendFacts = {
    pmsType: p.pmsType,
    ledger: new Map(),
    published: new Map(),
    today: p.today,
    nowMs: p.now.getTime(),
    reauthorizedAtMs: p.reauthorizedAtMs,
  };
  if (cells.length === 0 || !pmsSendsPrices(p.pmsType)) return facts;
  const [ledgerRows, publishedRows] = await Promise.all([
    readCells(admin, "rate_updates", LEDGER_COLUMNS, p.hotelId, cells),
    readCells(admin, "published_price", "room_type_id, stay_date, price", p.hotelId, cells),
  ]);
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
      retryRequestedAtMs: NaN,
    });
  }
  for (const r of publishedRows) {
    if (r.price != null) facts.published.set(cellKey(String(r.stay_date), String(r.room_type_id)), Number(r.price));
  }
  return facts;
}
