/**
 * In-memory stand-ins for booking_history_cache_get and _put from
 * 99_supabase_migration_booking_history_cache_v1.sql, written straight from
 * the SQL so engine tests run the store against fakeSupabase.
 * booking-history-cache-sql.test.ts checks the real functions and triggers
 * against this model in PGlite.
 *
 * The fake has no triggers, and tests change its tables directly, so the
 * hotel's booking_history_seq is worked out from what the triggers watch:
 * a digest of every reservation on a night before tomorrow (UTC) in the
 * columns the history reads. It moves exactly when a trigger would move the
 * number (and at UTC midnight too, which only means one more fresh read).
 * A booking_history_seq row in the tables is taken as it is instead: the
 * benches, whose past never changes, set one to skip the digest.
 */
import { describe, expect, it } from "vitest";
import type { FakeRow } from "./fake-supabase.test";

const DAY_MS = 86_400_000;
const ymd = (v: unknown) => String(v).slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** FNV-1a over a string, as a whole number below 2^53. */
function digest(text: string): number {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x0100019d) >>> 0;
  }
  return (h2 & 0x1fffff) * 4294967296 + h1;
}

/** The hotel's booking_history_seq, as the reservation triggers would have left it (see the header). */
export function historySeqOf(tables: Record<string, FakeRow[]>, hotelId: unknown): number {
  const row = (tables.booking_history_seq ?? []).find((r) => r.hotel_id === hotelId);
  if (row) return Number(row.seq);
  const cutoff = addDays(new Date().toISOString().slice(0, 10), 2);
  const past = (tables.reservations ?? [])
    .filter((r) => r.hotel_id === hotelId && ymd(r.stay_date) < cutoff)
    .map((r) =>
      [r.id, r.hotel_id, ymd(r.stay_date), r.room_type_id ?? "", r.booking_date == null ? "" : ymd(r.booking_date), r.booking_window_days ?? "", r.external_reservation_id ?? ""].join("\u0001"),
    )
    .sort();
  return past.length === 0 ? 0 : digest(past.join("\u0002"));
}

const DATED = /^\d{4}-\d{2}-\d{2}$/;

/** booking_history_cache_get: {seq, entries} for the keys kept under the current number, dated entries narrowed to p_dates. */
export function historyCacheGet(tables: Record<string, FakeRow[]>, a: Record<string, unknown>): unknown {
  const seq = historySeqOf(tables, a.p_hotel_id);
  const keys = new Set(((a.p_keys as string[] | null) ?? []).map(String));
  const dates = a.p_dates ? new Set((a.p_dates as string[]).map(ymd)) : null;
  const entries: Record<string, Record<string, unknown>> = {};
  for (const r of tables.booking_history_cache ?? []) {
    if (r.hotel_id !== a.p_hotel_id || ymd(r.hotel_date) !== ymd(a.p_hotel_date)) continue;
    if (!keys.has(String(r.cache_key)) || Number(r.history_seq) !== seq) continue;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r.entries as Record<string, unknown>)) {
      if (!dates || !DATED.test(k) || dates.has(k)) out[k] = v;
    }
    entries[String(r.cache_key)] = out;
  }
  // As it comes back over the wire: nothing shared with what is kept.
  return JSON.parse(JSON.stringify({ seq, entries }));
}

/** booking_history_cache_put: saves under p_seq while it is current, merging a key kept under the same number. */
export function historyCachePut(tables: Record<string, FakeRow[]>, a: Record<string, unknown>): number {
  const seq = historySeqOf(tables, a.p_hotel_id);
  if (a.p_seq == null || Number(a.p_seq) !== seq || a.p_hotel_date == null) return 0;
  const hotelDate = ymd(a.p_hotel_date);
  tables.booking_history_cache = (tables.booking_history_cache ?? []).filter(
    (r) =>
      !(r.hotel_id === a.p_hotel_id && (ymd(r.hotel_date) < addDays(hotelDate, -1) || Number(r.history_seq) !== seq)) &&
      !(ymd(r.hotel_date) < addDays(hotelDate, -7)),
  );
  const given = a.p_entries;
  if (!given || typeof given !== "object" || Array.isArray(given)) return 0;
  let n = 0;
  for (const [key, value] of Object.entries(JSON.parse(JSON.stringify(given)) as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const kept = tables.booking_history_cache.find(
      (r) => r.hotel_id === a.p_hotel_id && ymd(r.hotel_date) === hotelDate && r.cache_key === key,
    );
    if (kept) {
      kept.entries = Number(kept.history_seq) === seq ? { ...(kept.entries as object), ...(value as object) } : value;
      kept.history_seq = seq;
    } else {
      tables.booking_history_cache.push({ hotel_id: a.p_hotel_id, hotel_date: hotelDate, cache_key: key, history_seq: seq, entries: value });
    }
    n++;
  }
  return n;
}

/** An rpc handler for fakeSupabase that answers the booking history store's functions. */
export function historyCacheRpc(fn: string, args: unknown, tables: Record<string, FakeRow[]>): unknown {
  if (fn === "booking_history_cache_get") return historyCacheGet(tables, args as Record<string, unknown>);
  if (fn === "booking_history_cache_put") return historyCachePut(tables, args as Record<string, unknown>);
  return undefined;
}

describe("booking history store model", () => {
  const res = (over: FakeRow): FakeRow => ({
    id: "r1",
    hotel_id: "h1",
    stay_date: "2020-01-05",
    room_type_id: "k",
    booking_date: "2019-12-01",
    booking_window_days: 35,
    external_reservation_id: "100:1",
    current_rate: 100,
    ...over,
  });

  it("reads back what was saved under the current number, narrowed to the nights asked, and nothing once a past night's booking changes", () => {
    const tables: Record<string, FakeRow[]> = { reservations: [res({})] };
    const seq = (historyCacheGet(tables, { p_hotel_id: "h1", p_hotel_date: "2026-10-01", p_keys: [] }) as { seq: number }).seq;
    expect(historyCachePut(tables, { p_hotel_id: "h1", p_hotel_date: "2026-10-01", p_seq: seq, p_entries: { w: { "2020-01-05": { n: 1 }, "2020-01-06": null }, s: { rows: [1] } } })).toBe(2);
    expect(historyCacheGet(tables, { p_hotel_id: "h1", p_hotel_date: "2026-10-01", p_keys: ["w", "s"], p_dates: ["2020-01-06"] })).toEqual({
      seq,
      entries: { w: { "2020-01-06": null }, s: { rows: [1] } },
    });
    // Merged under the same number.
    historyCachePut(tables, { p_hotel_id: "h1", p_hotel_date: "2026-10-01", p_seq: seq, p_entries: { w: { "2020-01-07": { n: 2 } } } });
    expect(Object.keys((historyCacheGet(tables, { p_hotel_id: "h1", p_hotel_date: "2026-10-01", p_keys: ["w"] }) as { entries: { w: object } }).entries.w).sort()).toEqual([
      "2020-01-05",
      "2020-01-06",
      "2020-01-07",
    ]);
    // A rate change on a past night moves nothing; a new booking window does.
    tables.reservations[0].current_rate = 120;
    expect((historyCacheGet(tables, { p_hotel_id: "h1", p_hotel_date: "2026-10-01", p_keys: ["w"] }) as { seq: number }).seq).toBe(seq);
    tables.reservations[0].booking_window_days = 30;
    const after = historyCacheGet(tables, { p_hotel_id: "h1", p_hotel_date: "2026-10-01", p_keys: ["w", "s"] }) as { seq: number; entries: object };
    expect(after.seq).not.toBe(seq);
    expect(after.entries).toEqual({});
    // Saved under the old number: not saved.
    expect(historyCachePut(tables, { p_hotel_id: "h1", p_hotel_date: "2026-10-01", p_seq: seq, p_entries: { w: { "2020-01-05": null } } })).toBe(0);
  });

  it("moves no number for a booking on a night ahead, and keeps a set number as it is", () => {
    const tables: Record<string, FakeRow[]> = { reservations: [res({})] };
    const before = historySeqOf(tables, "h1");
    tables.reservations.push(res({ id: "r2", stay_date: "2099-01-01" }));
    expect(historySeqOf(tables, "h1")).toBe(before);
    tables.reservations.push(res({ id: "r3", stay_date: "2020-02-01" }));
    expect(historySeqOf(tables, "h1")).not.toBe(before);
    tables.booking_history_seq = [{ hotel_id: "h1", seq: 7 }];
    expect(historySeqOf(tables, "h1")).toBe(7);
  });

  it("drops the hotel's older days and numbers when it saves", () => {
    const tables: Record<string, FakeRow[]> = {
      reservations: [],
      booking_history_cache: [
        { hotel_id: "h1", hotel_date: "2026-09-28", cache_key: "a", history_seq: 0, entries: {} },
        { hotel_id: "h1", hotel_date: "2026-09-30", cache_key: "b", history_seq: 0, entries: {} },
        { hotel_id: "h1", hotel_date: "2026-10-01", cache_key: "c", history_seq: 5, entries: {} },
        { hotel_id: "h2", hotel_date: "2026-09-20", cache_key: "d", history_seq: 0, entries: {} },
        { hotel_id: "h2", hotel_date: "2026-09-28", cache_key: "e", history_seq: 0, entries: {} },
      ],
    };
    historyCachePut(tables, { p_hotel_id: "h1", p_hotel_date: "2026-10-01", p_seq: 0, p_entries: {} });
    expect(tables.booking_history_cache.map((r) => r.cache_key)).toEqual(["b", "e"]);
  });
});
