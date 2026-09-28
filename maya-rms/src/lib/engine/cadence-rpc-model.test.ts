/**
 * The functions and triggers of 99_supabase_migration_pricing_cadence_v1.sql
 * as the fake Supabase runs them: engine_run_gaps, pricing_work and
 * pricing_run_done over the fake's tables, and the marks the triggers write
 * (markNights, markHotel, markBookingChanges), which a test calls wherever it
 * changes what the triggers watch. pricing-cadence-sql.test.ts holds the real
 * SQL to the same contract in PGlite.
 *
 * engine_run_gaps answers by default (see fakeSupabase), so every engine
 * test runs the staleness guard the way a migrated database does. The rest
 * only when a test passes `rpc: cadenceRpc`: the tick tests that predate the
 * cadence run against a database without it.
 */
import { describe, expect, it } from "vitest";
import type { FakeRow } from "./fake-supabase.test";

type Tables = Record<string, FakeRow[]>;

const DAY_MS = 86_400_000;

function addDays(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function nextSeq(tables: Tables): number {
  const row = ((tables.__pricing_mark_seq ??= [{ value: 0 }])[0] as { value: number });
  row.value += 1;
  return row.value;
}

/**
 * pricing_mark_many: the (hotel, night) pairs as a trigger marks them. Nights
 * before yesterday (UTC, at `nowIso`) are skipped, as are hotels the fake does
 * not have.
 */
export function markNights(tables: Tables, hotelId: string, nights: Iterable<string>, reason: string, nowIso: string): void {
  if (tables.hotels && !tables.hotels.some((h) => h.id === hotelId)) return;
  const floor = addDays(nowIso.slice(0, 10), -1);
  const rows = (tables.pricing_dirty_nights ??= []);
  for (const night of [...new Set(nights)].sort()) {
    if (night < floor) continue;
    const hit = rows.find((r) => r.hotel_id === hotelId && r.stay_date === night);
    if (hit) {
      hit.last_marked_at = nowIso;
      hit.mark_seq = nextSeq(tables);
      const reasons = hit.reasons as string[];
      if (!reasons.includes(reason)) hit.reasons = [...reasons, reason];
    } else {
      rows.push({
        hotel_id: hotelId,
        stay_date: night,
        first_marked_at: nowIso,
        last_marked_at: nowIso,
        mark_seq: nextSeq(tables),
        reasons: [reason],
      });
    }
  }
}

/** Every night from `from` to `to` (pricing_mark_range), clipped as the SQL clips it. */
export function markRange(tables: Tables, hotelId: string, from: string, to: string, reason: string, nowIso: string): void {
  const today = nowIso.slice(0, 10);
  const first = from < addDays(today, -1) ? addDays(today, -1) : from;
  const last = to > addDays(today, 800) ? addDays(today, 800) : to;
  const nights: string[] = [];
  for (let d = first; d <= last; d = addDays(d, 1)) nights.push(d);
  markNights(tables, hotelId, nights, reason, nowIso);
}

/** pricing_mark_hotel: an edit that can move any night asks for a new pass. */
export function markHotel(tables: Tables, hotelId: string, nowIso: string): void {
  if (tables.hotels && !tables.hotels.some((h) => h.id === hotelId)) return;
  const rows = (tables.hotel_pricing_state ??= []);
  let state = rows.find((r) => r.hotel_id === hotelId);
  if (!state) {
    state = emptyState(hotelId);
    rows.push(state);
  }
  state.full_reprice_seq = nextSeq(tables);
  state.full_reprice_requested_at = nowIso;
}

/** The columns the reservation triggers compare (pricing_mark_reservations_upd). */
export const RESERVATION_PRICING_COLUMNS = [
  "hotel_id",
  "stay_date",
  "room_type_id",
  "current_rate",
  "base_rate",
  "booking_date",
  "booking_window_days",
  "external_reservation_id",
  "created_at",
] as const;

/**
 * The reservation triggers over a before and after copy of the table: marks
 * the nights of rows inserted or deleted, and both nights of an updated row
 * whose pricing columns changed (matched on id).
 */
export function markBookingChanges(tables: Tables, before: FakeRow[], after: FakeRow[], nowIso: string): void {
  const byId = (rows: FakeRow[]) => new Map(rows.map((r) => [String(r.id), r]));
  const old = byId(before);
  const now = byId(after);
  const touched = new Map<string, Set<string>>();
  const touch = (r: FakeRow) => {
    const set = touched.get(String(r.hotel_id)) ?? new Set<string>();
    set.add(String(r.stay_date));
    touched.set(String(r.hotel_id), set);
  };
  for (const [id, r] of now) {
    const o = old.get(id);
    if (!o) touch(r);
    else if (RESERVATION_PRICING_COLUMNS.some((c) => (o[c] ?? null) !== (r[c] ?? null))) {
      touch(o);
      touch(r);
    }
  }
  for (const [id, o] of old) if (!now.has(id)) touch(o);
  for (const [hotelId, nights] of touched) markNights(tables, hotelId, nights, "booking", nowIso);
}

function emptyState(hotelId: string): FakeRow {
  return {
    hotel_id: hotelId,
    pass_date: null,
    pass_cursor: null,
    pass_started_at: null,
    pass_completed_at: null,
    pass_reason: null,
    pass_horizon_days: null,
    pass_reprice_seq: null,
    full_reprice_seq: null,
    full_reprice_requested_at: null,
    last_ok_run_at: null,
    momentum_nights: [],
    ms_per_night: null,
  };
}

/** engine_run_gaps, over evaluation_run_log. */
export function engineRunGaps(args: Record<string, unknown>, tables: Tables): FakeRow[] {
  const from = Date.parse(String(args.p_from));
  const to = Date.parse(String(args.p_to));
  const minGap = Number(args.p_min_gap_seconds) * 1000;
  const runs = (tables.evaluation_run_log ?? [])
    .filter((r) => r.hotel_id === args.p_hotel_id)
    .map((r) => Date.parse(String(r.evaluated_at)))
    .filter((t) => t > from && t < to);
  const all = [from, ...runs, to].sort((a, b) => a - b);
  const out: FakeRow[] = [];
  for (let i = 1; i < all.length; i++) {
    if (all[i] - all[i - 1] > minGap) {
      out.push({ gap_from: new Date(all[i - 1]).toISOString(), gap_to: new Date(all[i]).toISOString() });
    }
  }
  return out;
}

/** pricing_work. */
export function pricingWork(args: Record<string, unknown>, tables: Tables): FakeRow {
  const hotel = args.p_hotel_id;
  const first = String(args.p_first);
  const last = String(args.p_last);
  const atMs = Date.parse(String(args.p_at));
  const inWindow = (d: unknown) => String(d) >= first && String(d) <= last;
  const wakeups = (tables.pricing_wakeups ?? []).filter((w) => w.hotel_id === hotel && inWindow(w.stay_date));
  const future = wakeups.filter((w) => Date.parse(String(w.due_at)) > atMs).map((w) => Date.parse(String(w.due_at)));
  const state = (tables.hotel_pricing_state ?? []).find((s) => s.hotel_id === hotel) ?? null;
  return {
    dirty: (tables.pricing_dirty_nights ?? [])
      .filter((d) => d.hotel_id === hotel && inWindow(d.stay_date))
      .sort((a, b) => String(a.stay_date).localeCompare(String(b.stay_date)))
      .map((d) => ({ stay_date: d.stay_date, mark_seq: d.mark_seq, first_marked_at: d.first_marked_at, reasons: d.reasons })),
    wakeups: wakeups
      .filter((w) => Date.parse(String(w.due_at)) <= atMs)
      .sort((a, b) => String(a.stay_date).localeCompare(String(b.stay_date)) || Date.parse(String(a.due_at)) - Date.parse(String(b.due_at)))
      .map((w) => ({ stay_date: w.stay_date, due_at: w.due_at, reason: w.reason })),
    next_wakeup_at: future.length > 0 ? new Date(Math.min(...future)).toISOString() : null,
    state: state ? { ...state } : null,
  };
}

/** pricing_run_done. */
export function pricingRunDone(args: Record<string, unknown>, tables: Tables): FakeRow {
  const hotel = String(args.p_hotel_id);
  const run = args.p_run as Record<string, unknown>;
  const at = String(run.at);
  const atMs = Date.parse(at);
  const first = String(run.first);
  const last = String(run.last);
  const nights = new Set((run.nights as string[]) ?? []);
  const dirty = (tables.pricing_dirty_nights ??= []);
  const wake = (tables.pricing_wakeups ??= []);

  let cleared = 0;
  for (const read of (run.dirty as { stay_date: string; mark_seq: number }[]) ?? []) {
    if (!nights.has(read.stay_date)) continue;
    const i = dirty.findIndex((d) => d.hotel_id === hotel && d.stay_date === read.stay_date && Number(d.mark_seq) <= read.mark_seq);
    if (i >= 0) {
      dirty.splice(i, 1);
      cleared++;
    }
  }
  let kept = 0;
  for (const d of dirty) {
    if (d.hotel_id !== hotel || !nights.has(String(d.stay_date))) continue;
    if (Date.parse(String(d.first_marked_at)) < atMs) d.first_marked_at = at;
    kept++;
  }
  for (let i = wake.length - 1; i >= 0; i--) {
    const w = wake[i];
    if (w.hotel_id !== hotel) continue;
    const sd = String(w.stay_date);
    if ((nights.has(sd) && Date.parse(String(w.due_at)) <= atMs) || sd < first || sd > last) wake.splice(i, 1);
  }
  for (let i = dirty.length - 1; i >= 0; i--) {
    const d = dirty[i];
    if (d.hotel_id === hotel && (String(d.stay_date) < first || String(d.stay_date) > last)) dirty.splice(i, 1);
  }
  let added = 0;
  for (const w of (run.wakeups as { stay_date: string; due_at: string; reason: string }[]) ?? []) {
    if (w.stay_date < first || w.stay_date > last || !(Date.parse(w.due_at) > atMs)) continue;
    const dueMs = Date.parse(w.due_at);
    if (wake.some((x) => x.hotel_id === hotel && x.stay_date === w.stay_date && Date.parse(String(x.due_at)) === dueMs)) continue;
    wake.push({ hotel_id: hotel, stay_date: w.stay_date, due_at: new Date(dueMs).toISOString(), reason: w.reason ?? "wait_ends" });
    added++;
  }
  markNights(tables, hotel, (run.failed as string[]) ?? [], "retry", at);

  const states = (tables.hotel_pricing_state ??= []);
  let state = states.find((s) => s.hotel_id === hotel);
  if (!state) {
    state = emptyState(hotel);
    states.push(state);
  }
  const pass = run.pass as Record<string, unknown> | null;
  let moved: boolean | null = null;
  if (pass && pass.start) {
    state.pass_date = pass.date;
    state.pass_cursor = pass.next ?? null;
    state.pass_started_at = at;
    state.pass_completed_at = pass.next == null ? at : null;
    state.pass_reason = pass.reason;
    state.pass_horizon_days = pass.horizon;
    state.pass_reprice_seq = pass.reprice_seq ?? state.pass_reprice_seq;
    moved = true;
  } else if (pass) {
    moved = state.pass_date === pass.date && state.pass_cursor === pass.from;
    if (moved) {
      state.pass_cursor = pass.next ?? null;
      state.pass_completed_at = pass.next == null ? at : null;
    }
  }
  // Each night's momentum flag is the one its latest pricing found.
  const momentum = new Set((run.momentum as string[]) ?? []);
  state.momentum_nights = [
    ...new Set([...(state.momentum_nights as string[]).filter((m) => !nights.has(m) && m >= first), ...momentum]),
  ].sort();
  const lastOk = state.last_ok_run_at ? Date.parse(String(state.last_ok_run_at)) : NaN;
  if (!(lastOk >= atMs)) state.last_ok_run_at = at;
  if (run.ms_per_night != null) {
    const v = Number(run.ms_per_night);
    state.ms_per_night = state.ms_per_night == null ? v : Math.round((Number(state.ms_per_night) * 0.8 + v * 0.2) * 1000) / 1000;
  }
  if (run.idle && run.run_id) {
    (tables.evaluation_run_log ??= []).push({
      id: `idle-${run.run_id}`,
      hotel_id: hotel,
      evaluation_run_id: run.run_id,
      evaluated_at: at,
      cells_checked: 0,
      cells_changed: 0,
      run_kind: "idle",
      nights_priced: 0,
    });
  }
  return { cleared, kept, wakeups: added, pass_moved: moved };
}

/** For fakeSupabase's rpc option: the cadence functions, undefined for anything else. */
export function cadenceRpc(fn: string, args: unknown, tables: Tables): unknown {
  const a = args as Record<string, unknown>;
  switch (fn) {
    case "engine_run_gaps":
      return engineRunGaps(a, tables);
    case "pricing_work":
      return pricingWork(a, tables);
    case "pricing_run_done":
      return pricingRunDone(a, tables);
    case "request_full_reprice":
      markHotel(tables, String(a.p_hotel_id), new Date().toISOString());
      return null;
    default:
      return undefined;
  }
}

/** The part of the model every fake answers by default. */
export function runGapsRpc(fn: string, args: unknown, tables: Tables): unknown {
  return fn === "engine_run_gaps" ? engineRunGaps(args as Record<string, unknown>, tables) : undefined;
}

describe("cadence rpc model", () => {
  it("keeps a night marked again after it was read, and books wake-ups inside the window only", () => {
    const tables: Tables = { hotels: [{ id: "h" }] };
    const now = "2026-10-01T12:00:00.000Z";
    markNights(tables, "h", ["2026-10-02", "2026-10-03", "2026-09-01"], "booking", now);
    expect(tables.pricing_dirty_nights.map((d) => d.stay_date)).toEqual(["2026-10-02", "2026-10-03"]);
    const work = pricingWork({ p_hotel_id: "h", p_first: "2026-10-01", p_last: "2026-10-10", p_at: now }, tables) as {
      dirty: { stay_date: string; mark_seq: number }[];
    };
    markNights(tables, "h", ["2026-10-03"], "manual_price", now);
    pricingRunDone(
      {
        p_hotel_id: "h",
        p_run: {
          at: now,
          first: "2026-10-01",
          last: "2026-10-10",
          nights: ["2026-10-02", "2026-10-03"],
          dirty: work.dirty,
          wakeups: [
            { stay_date: "2026-10-02", due_at: "2026-10-02T12:00:00.000Z", reason: "pickup_window" },
            { stay_date: "2026-10-20", due_at: "2026-10-02T12:00:00.000Z", reason: "pickup_window" },
            { stay_date: "2026-10-02", due_at: "2026-10-01T11:00:00.000Z", reason: "wait_ends" },
          ],
          failed: [],
          pass: null,
          momentum: [],
          idle: false,
        },
      },
      tables,
    );
    expect(tables.pricing_dirty_nights.map((d) => [d.stay_date, d.reasons])).toEqual([["2026-10-03", ["booking", "manual_price"]]]);
    expect(tables.pricing_wakeups.map((w) => w.stay_date)).toEqual(["2026-10-02"]);
  });

  it("finds the stretches without a run longer than the gap", () => {
    const tables: Tables = {
      evaluation_run_log: [
        { hotel_id: "h", evaluated_at: "2026-10-01T01:00:00.000Z" },
        { hotel_id: "h", evaluated_at: "2026-10-01T02:00:00.000Z" },
        { hotel_id: "h", evaluated_at: "2026-10-01T20:00:00.000Z" },
      ],
    };
    expect(
      engineRunGaps(
        { p_hotel_id: "h", p_from: "2026-09-30T00:00:00.000Z", p_to: "2026-10-02T00:00:00.000Z", p_min_gap_seconds: 43200 },
        tables,
      ),
    ).toEqual([
      { gap_from: "2026-09-30T00:00:00.000Z", gap_to: "2026-10-01T01:00:00.000Z" },
      { gap_from: "2026-10-01T02:00:00.000Z", gap_to: "2026-10-01T20:00:00.000Z" },
    ]);
  });
});
