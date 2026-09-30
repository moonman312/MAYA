/**
 * What the base rate refresh writes down about rates changed in the PMS:
 * the day counts and the warning that something other than MAYA seems to be
 * changing rates (under "Keep the change"), and one change log item per
 * overwrite (under "MAYA's price wins").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  changesInWindow,
  looksLikeAnotherTool,
  nextChangeDays,
  OTHER_TOOL_CHANGE_DAYS,
  OTHER_TOOL_CHANGES_IN_ONE_READ,
  OTHER_TOOL_QUIET_DAYS,
  OTHER_TOOL_WINDOW_DAYS,
  PMS_CHANGE_NOTICE_KEEP_DAYS,
  recordOverwrites,
  watchPmsChanges,
} from "../../../supabase/functions/_shared/pms/pms-change-watch";
import { adoptPmsEdits, type PushedNightRead } from "../../../supabase/functions/_shared/pms/pms-edits";
import { fakeSupabase } from "../engine/fake-supabase.test";

const DAY = 86_400_000;
const T0 = Date.parse("2026-10-06T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("the thresholds", () => {
  it("are the ones Jake set: 20 in one read, or 3 days in 7, and one warning a week", () => {
    expect(OTHER_TOOL_CHANGES_IN_ONE_READ).toBe(20);
    expect(OTHER_TOOL_CHANGE_DAYS).toBe(3);
    expect(OTHER_TOOL_WINDOW_DAYS).toBe(7);
    expect(OTHER_TOOL_QUIET_DAYS).toBe(7);
    expect(PMS_CHANGE_NOTICE_KEEP_DAYS).toBe(180);
  });
});

describe("nextChangeDays", () => {
  it("adds today's changes and keeps only the last 7 days", () => {
    const prev = { "2026-09-29": 4, "2026-09-30": 2, "2026-10-05": 1, junk: 3, "2026-10-04": 0 };
    expect(nextChangeDays(prev, "2026-10-06", 5)).toEqual({ "2026-09-30": 2, "2026-10-05": 1, "2026-10-06": 5 });
    expect(nextChangeDays({ "2026-10-06": 2 }, "2026-10-06", 3)).toEqual({ "2026-10-06": 5 });
    expect(nextChangeDays(null, "2026-10-06", 1)).toEqual({ "2026-10-06": 1 });
    expect(nextChangeDays(["2026-10-06"], "2026-10-06", 0)).toEqual({});
  });
});

describe("looksLikeAnotherTool", () => {
  const days = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`2026-10-0${i + 1}`, 1]));
  it("fires on 20 changes in one read, or changes on 3 different days", () => {
    expect(looksLikeAnotherTool({ changes: 20, days: days(1), lastWarnedAtMs: NaN, nowMs: T0 })).toBe(true);
    expect(looksLikeAnotherTool({ changes: 19, days: days(1), lastWarnedAtMs: NaN, nowMs: T0 })).toBe(false);
    expect(looksLikeAnotherTool({ changes: 1, days: days(3), lastWarnedAtMs: NaN, nowMs: T0 })).toBe(true);
    expect(looksLikeAnotherTool({ changes: 1, days: days(2), lastWarnedAtMs: NaN, nowMs: T0 })).toBe(false);
  });
  it("stays quiet for 7 days after a warning", () => {
    expect(looksLikeAnotherTool({ changes: 40, days: days(5), lastWarnedAtMs: T0 - 6 * DAY, nowMs: T0 })).toBe(false);
    expect(looksLikeAnotherTool({ changes: 40, days: days(5), lastWarnedAtMs: T0 - 7 * DAY - 1, nowMs: T0 })).toBe(true);
  });
  it("counts the rates changed over the window", () => {
    expect(changesInWindow({ a: 4, b: 2 })).toBe(6);
  });
});

describe("watchPmsChanges", () => {
  it("warns on the third day with changes in a week, once, and says how many rates changed", async () => {
    const d = fakeSupabase({ pms_change_watch: [], pms_change_notices: [] });
    const at = (n: number) => iso(T0 + n * DAY);
    const day = (n: number) => at(n).slice(0, 10);
    expect(await watchPmsChanges(d.client, "h1", "think", { changes: 2, today: day(0), at: at(0) })).toEqual({ warned: false, rates: 2 });
    expect(await watchPmsChanges(d.client, "h1", "think", { changes: 3, today: day(2), at: at(2) })).toEqual({ warned: false, rates: 5 });
    expect(await watchPmsChanges(d.client, "h1", "think", { changes: 1, today: day(4), at: at(4) })).toEqual({ warned: true, rates: 6 });
    expect(d.tables.pms_change_notices).toEqual([
      expect.objectContaining({ hotel_id: "h1", pms_type: "think", kind: "other_tool", rates: 6, found_at: at(4) }),
    ]);
    // Quiet for a week, however much changes.
    expect(await watchPmsChanges(d.client, "h1", "think", { changes: 30, today: day(5), at: at(5) })).toEqual({ warned: false, rates: 36 });
    // Past the quiet week the old days have left the window; a big read warns again.
    const later = await watchPmsChanges(d.client, "h1", "think", { changes: 25, today: day(12), at: at(12) });
    expect(later).toEqual({ warned: true, rates: 25 });
    expect(d.tables.pms_change_notices).toHaveLength(2);
    expect(d.tables.pms_change_watch).toEqual([expect.objectContaining({ hotel_id: "h1", other_tool_notice_at: at(12), change_days: { [day(12)]: 25 } })]);
  });

  it("counts nothing when nothing changed, and never fails the refresh", async () => {
    const d = fakeSupabase({}, { fault: (c) => (c.table === "pms_change_watch" ? { message: "canceling statement due to statement timeout" } : null) });
    expect(await watchPmsChanges(d.client, "h1", "cloudbeds", { changes: 0, at: iso(T0) })).toBeNull();
    expect(await watchPmsChanges(d.client, "h1", "cloudbeds", { changes: 25, at: iso(T0) })).toBeNull();
    // A database before the migration: nothing to count in, quietly.
    const pre = fakeSupabase({}, { fault: (c) => (c.table === "pms_change_watch" ? { code: "PGRST205", message: "Could not find the table 'public.pms_change_watch' in the schema cache" } : null) });
    expect(await watchPmsChanges(pre.client, "h1", "cloudbeds", { changes: 25, at: iso(T0) })).toBeNull();
  });

  it("hands the warning back when its change log item can't be written, so a later read tries again", async () => {
    let failInsert = true;
    const d = fakeSupabase({ pms_change_watch: [], pms_change_notices: [] }, {
      fault: (c) => (failInsert && c.table === "pms_change_notices" && c.op === "insert" ? { message: "boom" } : null),
    });
    expect(await watchPmsChanges(d.client, "h1", "cloudbeds", { changes: 20, at: iso(T0) })).toBeNull();
    expect(d.tables.pms_change_watch[0].other_tool_notice_at ?? null).toBeNull();
    failInsert = false;
    expect(await watchPmsChanges(d.client, "h1", "cloudbeds", { changes: 20, at: iso(T0 + 60_000) })).toEqual({ warned: true, rates: 40 });
  });
});

describe("recordOverwrites", () => {
  const night = (stayDate: string, price: number) => ({ stayDate, roomTypeId: "rt-king", ledger: { price } });

  it("writes one item per night and room type with MAYA's published price, and lets items past 180 days go", async () => {
    const d = fakeSupabase({
      published_price: [{ hotel_id: "h1", stay_date: "2026-10-09", room_type_id: "rt-king", price: 172 }],
      pms_change_notices: [
        { id: "old", hotel_id: "h1", pms_type: "cloudbeds", kind: "overwrite", found_at: iso(T0 - 181 * DAY) },
        { id: "recent", hotel_id: "h1", pms_type: "cloudbeds", kind: "overwrite", found_at: iso(T0 - 179 * DAY) },
        { id: "theirs", hotel_id: "h2", pms_type: "cloudbeds", kind: "overwrite", found_at: iso(T0 - 400 * DAY) },
      ],
      pms_change_watch: [],
    });
    const n = await recordOverwrites(d.client, "h1", "cloudbeds", [
      { read: night("2026-10-09", 165), pmsRate: 190 },
      // No published price: the price MAYA last sent.
      { read: night("2026-10-10", 165), pmsRate: null },
    ], iso(T0));
    expect(n).toBe(2);
    expect(d.tables.pms_change_notices.map((r) => r.id)).toEqual(["recent", "theirs", expect.any(String), expect.any(String)]);
    expect(d.tables.pms_change_notices.slice(2)).toEqual([
      expect.objectContaining({ kind: "overwrite", stay_date: "2026-10-09", pms_rate: 190, maya_price: 172, found_at: iso(T0) }),
      expect.objectContaining({ kind: "overwrite", stay_date: "2026-10-10", pms_rate: null, maya_price: 165, found_at: iso(T0) }),
    ]);
    expect(d.tables.pms_change_watch).toEqual([expect.objectContaining({ hotel_id: "h1" })]);
  });

  it("never fails the refresh", async () => {
    const d = fakeSupabase({}, { fault: (c) => (c.table === "pms_change_notices" ? { message: "boom" } : null) });
    expect(await recordOverwrites(d.client, "h1", "cloudbeds", [{ read: night("2026-10-09", 165), pmsRate: 190 }], iso(T0))).toBe(0);
  });
});

describe("adoptPmsEdits and the watch", () => {
  const TARGETS = { "CB-KING": "rate-1" };
  const WINDOW = { firstDate: "2026-10-06", lastDate: "2026-12-31" };
  const read = (n: number, pmsRate: number): PushedNightRead => ({
    stayDate: `2026-10-${String(10 + n).padStart(2, "0")}`,
    roomTypeId: "rt-king",
    externalRoomTypeId: "CB-KING",
    pmsRate,
    ledger: {
      status: "sent", price: 150, sent_price: 150, attempts: 1, pms_type: "cloudbeds", external_room_type_id: "CB-KING",
      external_rate_id: "rate-1", pms_job_reference: "job-1", confirmed_at: iso(T0 - 2 * 3_600_000), pushed_at: iso(T0 - 2 * 3_600_000),
    },
  });
  const db = (mode: string) =>
    fakeSupabase({
      hotel_settings: [{ hotel_id: "h1", simulation_mode: false, live_since: iso(T0 - 30 * DAY), pms_rate_changes: mode }],
      manual_price: [],
      rate_updates: [],
      base_rate_calendar: [],
      pms_change_watch: [],
      pms_change_notices: [],
      pricing_rules: [],
    });

  it("counts the changes it keeps, and the rates removed, toward the warning", async () => {
    const d = db("keep");
    const missing = Array.from({ length: 5 }, (_, n) => {
      const r = read(20 + n, 0);
      return { stayDate: r.stayDate, roomTypeId: r.roomTypeId, externalRoomTypeId: r.externalRoomTypeId, ledger: r.ledger };
    });
    const reads = Array.from({ length: 15 }, (_, n) => read(n, 170 + n));
    const res = await adoptPmsEdits(d.client, "h1", "cloudbeds", reads, TARGETS, WINDOW, iso(T0), { missing, today: "2026-10-06" });
    expect(res).toMatchObject({ adopted: 15, removed: 5, overwritten: 0 });
    expect(d.tables.pms_change_notices).toEqual([expect.objectContaining({ kind: "other_tool", rates: 20 })]);
  });

  it("writes an item per overwrite and counts nothing under MAYA's price wins", async () => {
    const d = db("maya_wins");
    const reads = Array.from({ length: 22 }, (_, n) => read(n, 170 + n));
    const res = await adoptPmsEdits(d.client, "h1", "cloudbeds", reads, TARGETS, WINDOW, iso(T0), { today: "2026-10-06" });
    expect(res).toMatchObject({ adopted: 0, overwritten: 22, movedCells: [] });
    expect(d.tables.manual_price).toEqual([]);
    expect(d.tables.pms_change_notices.filter((r) => r.kind === "overwrite")).toHaveLength(22);
    expect(d.tables.pms_change_notices.filter((r) => r.kind === "other_tool")).toEqual([]);
    expect(d.tables.pms_change_watch).toEqual([{ hotel_id: "h1", updated_at: iso(T0), id: expect.any(String) }]);
    // The ledger says what Cloudbeds holds, so the push sends MAYA's price over it.
    expect(d.tables.rate_updates.map((r) => r.price)).toEqual(reads.map((r) => r.pmsRate));
  });
});
