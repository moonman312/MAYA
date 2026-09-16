/**
 * The import analyses a property twice — early, on three years, and again on
 * everything — and either pass can repeat after a crash. These run the real
 * analyzeImport against an in-memory database across both passes and the
 * owner's answers in between.
 */
import { describe, expect, it, vi } from "vitest";
import {
  analyzeImport,
  findingKey,
  planFindingWrites,
  type DailyRoomNights,
  type RoomTypeStats,
} from "../../../supabase/functions/_shared/onboarding/analysis";
import type { ImportJobRow } from "../../../supabase/functions/_shared/onboarding/worker-core";
import { callTouchesColumn, fakeSupabase, missingColumn, type FakeRow } from "../engine/fake-supabase.test";

const HOTEL = "hotel-1";

/** Busy every day from `from` for `days` days, except inside the closures. */
function series(from: string, days: number, closures: Array<[string, string]>): DailyRoomNights[] {
  const out: DailyRoomNights[] = [];
  const start = new Date(`${from}T00:00:00Z`);
  for (let i = 0; i < days; i += 1) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    const ymd = d.toISOString().slice(0, 10);
    if (closures.some(([a, b]) => ymd >= a && ymd <= b)) continue;
    out.push({ stay_date: ymd, room_nights: 12 });
  }
  return out;
}

const WINTER_2023: [string, string] = ["2023-12-10", "2024-01-15"];
const WINTER_2024: [string, string] = ["2024-12-10", "2025-01-15"];
const WINTER_2025: [string, string] = ["2025-12-10", "2026-01-15"];

/** Three years: two winters closed. */
const EARLY_DAILY = series("2024-06-01", 800, [WINTER_2024, WINTER_2025]);
/** Everything: a third, older winter appears. */
const FINAL_DAILY = series("2023-06-01", 1165, [WINTER_2023, WINTER_2024, WINTER_2025]);

function stat(s: Partial<RoomTypeStats>): RoomTypeStats {
  return {
    room_type_id: "rt-x",
    external_room_type_id: "ext",
    name: "Deluxe King",
    is_active: true,
    row_count: 900,
    median_rate: 200,
    p99_rate: 400,
    max_rate: 500,
    reservation_count: 300,
    single_night_reservations: 40,
    median_los: 3,
    ...s,
  };
}

function hotelDb() {
  let daily = EARLY_DAILY;
  let kingMax = 5000;
  const db = fakeSupabase(
    {
      room_types: [
        { id: "rt-king", hotel_id: HOTEL, name: "Deluxe King", is_active: true, floor_price: 0, ceiling_price: 99999, counts_as_room: null, counts_as_room_set_by: null },
        { id: "rt-dead", hotel_id: HOTEL, name: "Deluxe  King", is_active: true, floor_price: 0, ceiling_price: 99999, counts_as_room: null, counts_as_room_set_by: null },
        { id: "rt-court", hotel_id: HOTEL, name: "Tennis Court", is_active: true, floor_price: 0, ceiling_price: 99999, counts_as_room: null, counts_as_room_set_by: null },
      ],
    },
    {
      rpc: (fn) => {
        if (fn === "onboarding_daily_room_nights") return daily;
        if (fn !== "onboarding_room_type_stats") return null;
        // Like the real aggregate, is_active is read off room_types as it is now.
        const active = (id: string) => db.tables.room_types.find((r) => r.id === id)?.is_active === true;
        return [
          stat({ room_type_id: "rt-king", name: "Deluxe King", max_rate: kingMax, is_active: active("rt-king") }),
          stat({ room_type_id: "rt-dead", name: "Deluxe  King", row_count: 0, reservation_count: 0, median_rate: null, p99_rate: null, max_rate: null, is_active: active("rt-dead") }),
          stat({ room_type_id: "rt-court", name: "Tennis Court", row_count: 40, reservation_count: 40, median_rate: 30, p99_rate: 40, max_rate: 40, is_active: active("rt-court") }),
        ];
      },
    },
  );
  return {
    ...db,
    moreHistoryArrives: () => {
      daily = FINAL_DAILY;
      kingMax = 6000;
    },
  };
}

function importJob(stats: Record<string, unknown> = {}): ImportJobRow {
  return {
    id: "job-1",
    hotel_id: HOTEL,
    pms_type: "cloudbeds",
    status: "running",
    phase: "analyze_early",
    window_index: 3,
    window_from: null,
    window_to: null,
    enum_cursor: {},
    row_cap: 300_000,
    max_windows: 10,
    reservations_enumerated: 0,
    rows_upserted: 0,
    windows_completed: 3,
    oldest_stay_date: null,
    newest_stay_date: null,
    attempts: 1,
    stats,
  };
}

const findingsOf = (db: ReturnType<typeof hotelDb>, kind?: string) =>
  db.tables.onboarding_findings.filter((f) => !kind || f.kind === kind);

describe("analysing an import early and again at the end", () => {
  it("never duplicates a finding or a starter rule, and refines rather than re-asks", async () => {
    const db = hotelDb();
    const job = importJob();

    // Early pass on three years.
    await analyzeImport(db.client, job, "early");

    expect(findingsOf(db).map((f) => `${f.kind}/${f.status}`).sort()).toEqual([
      "closed_period/proposed",
      "duplicate_room_type/auto_applied",
      "rate_outlier/proposed",
      "suspect_room_type/proposed",
    ]);
    const season = findingsOf(db, "closed_period")[0];
    expect(season.payload).toMatchObject({ recurring: true, years_observed: 2 });
    expect(season.finding_key).toBe(findingKey("closed_period", season.payload as FakeRow));
    expect(db.tables.room_types.find((r) => r.id === "rt-dead")?.is_active).toBe(false);
    expect(db.tables.pricing_rules).toHaveLength(5);
    expect(db.tables.rule_condition).toHaveLength(5);
    expect(job.stats.starterRules).toHaveLength(5);
    expect((job.stats.starterRules as Array<Record<string, unknown>>)[0]).toEqual({
      name: expect.any(String),
      explanation: expect.any(String),
    });

    // The same pass again, as after a crash before its checkpoint landed, with
    // the job's stats lost along with it.
    const ids = findingsOf(db).map((f) => f.id).sort();
    const retry = importJob();
    await analyzeImport(db.client, retry, "early");
    expect(findingsOf(db).map((f) => f.id).sort()).toEqual(ids);
    expect(db.tables.pricing_rules).toHaveLength(5);
    expect(retry.stats.starterRules).toHaveLength(5);

    // The owner reviews while the older years import: the closure is real, the
    // "duplicate" is a real room type, the court is a room after all, and the
    // starter rules go.
    const seasonPeriods = (season.payload as { periods: Array<{ start_date: string; end_date: string }> }).periods;
    season.status = "confirmed";
    for (const p of seasonPeriods) {
      db.tables.hotel_closed_periods ??= [];
      db.tables.hotel_closed_periods.push({ hotel_id: HOTEL, room_type_id: null, start_date: p.start_date, end_date: p.end_date, source: "onboarding" });
    }
    const dup = findingsOf(db, "duplicate_room_type")[0];
    dup.status = "dismissed";
    db.tables.room_types.find((r) => r.id === "rt-dead")!.is_active = true;
    const suspect = findingsOf(db, "suspect_room_type")[0];
    suspect.status = "dismissed";
    Object.assign(db.tables.room_types.find((r) => r.id === "rt-court")!, { counts_as_room: true, counts_as_room_set_by: "owner-1" });
    db.tables.pricing_rules.length = 0;
    const outlierId = findingsOf(db, "rate_outlier")[0].id;

    // Final pass on everything, twice over.
    db.moreHistoryArrives();
    for (let run = 0; run < 2; run += 1) {
      await analyzeImport(db.client, { ...job, phase: "analyze", stats: { ...job.stats, earlyAnalysisAt: "2026-09-16T10:00:00Z" } }, "final");

      // The confirmed season gained its older winter on record, not as a new question.
      expect(findingsOf(db, "closed_period")).toHaveLength(1);
      expect(season.status).toBe("confirmed");
      expect((season.payload as { periods: unknown[] }).periods).toHaveLength(3);
      expect(season.payload).toMatchObject({ years_observed: 3 });
      expect(db.tables.hotel_closed_periods.map((p) => p.start_date).sort()).toEqual([
        "2023-12-10",
        "2024-12-10",
        "2025-12-10",
      ]);
      // The type the owner brought back stays back, with no fresh paperwork.
      expect(db.tables.room_types.find((r) => r.id === "rt-dead")?.is_active).toBe(true);
      expect(findingsOf(db, "duplicate_room_type").map((f) => f.status)).toEqual(["dismissed"]);
      // Answered, so not asked again.
      expect(findingsOf(db, "suspect_room_type").map((f) => f.status)).toEqual(["dismissed"]);
      // The open outlier card is the same card, carrying the new numbers.
      expect(findingsOf(db, "rate_outlier").map((f) => [f.id, f.status])).toEqual([[outlierId, "proposed"]]);
      expect(findingsOf(db, "rate_outlier")[0].payload).toMatchObject({ max_rate: 6000 });
      // Removed starter rules are not rebuilt behind the owner's back.
      expect(db.tables.pricing_rules).toHaveLength(0);
    }
  });

  it("re-raises the older instances of a season only when it was never answered", async () => {
    const db = hotelDb();
    await analyzeImport(db.client, importJob(), "early");
    const earlyId = findingsOf(db, "closed_period")[0].id;

    db.moreHistoryArrives();
    await analyzeImport(db.client, importJob({ earlyAnalysisAt: "x", starterRulesAt: "x" }), "final");

    // Still open: refined in place, same id, now three winters.
    const seasons = findingsOf(db, "closed_period");
    expect(seasons.map((f) => f.id)).toEqual([earlyId]);
    expect((seasons[0].payload as { periods: unknown[] }).periods).toHaveLength(3);
  });

  it("drops a whole season the owner dismissed, older years included", async () => {
    const db = hotelDb();
    await analyzeImport(db.client, importJob(), "early");
    findingsOf(db, "closed_period")[0].status = "dismissed";

    db.moreHistoryArrives();
    await analyzeImport(db.client, importJob({ earlyAnalysisAt: "x", starterRulesAt: "x" }), "final");

    expect(findingsOf(db, "closed_period").map((f) => f.status)).toEqual(["dismissed"]);
    expect(db.tables.hotel_closed_periods ?? []).toHaveLength(0);
  });

  it("writes the same findings without a key on a database that has not had the migration", async () => {
    let refused = 0;
    const base = hotelDb();
    const db = fakeSupabase(
      { room_types: base.tables.room_types },
      {
        rpc: (fn) => (fn === "onboarding_daily_room_nights" ? EARLY_DAILY : fn === "onboarding_room_type_stats" ? [
          stat({ room_type_id: "rt-king", name: "Deluxe King", max_rate: 5000 }),
        ] : null),
        fault: (call) => {
          if (call.table === "onboarding_findings" && call.op === "insert" && callTouchesColumn(call, "finding_key")) {
            refused += 1;
            return { ...missingColumn("onboarding_findings", "finding_key"), code: "PGRST204" };
          }
          return null;
        },
      },
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await analyzeImport(db.client, importJob(), "early");

    expect(refused).toBe(1);
    expect(db.tables.onboarding_findings.map((f) => f.kind).sort()).toEqual(["closed_period", "rate_outlier"]);
    expect(db.tables.onboarding_findings.every((f) => !("finding_key" in f))).toBe(true);
    expect(String(warn.mock.calls[0]?.[0])).toContain("99_supabase_migration_import_early_analysis_v1.sql");
    warn.mockRestore();
  });
});

describe("planFindingWrites", () => {
  const open = (id: string, kind: string, payload: Record<string, unknown>) => ({ id, kind, status: "proposed", job_id: "job-1", payload });

  it("updates a card that asks the same question, keeps an unchanged one, and removes what is no longer found", () => {
    const plan = planFindingWrites(
      [
        { kind: "rate_outlier", status: "proposed", payload: { room_type_id: "rt-1", max_rate: 900 } },
        { kind: "suspect_room_type", status: "proposed", payload: { room_type_id: "rt-2", reasons: ["a"] } },
        { kind: "zero_rate_rows", status: "proposed", payload: { count: 4, share: 0.03 } },
      ],
      [
        open("f1", "rate_outlier", { room_type_id: "rt-1", max_rate: 800 }),
        open("f2", "suspect_room_type", { reasons: ["a"], room_type_id: "rt-2" }),
        open("f3", "unmapped_room_type", { count: 2 }),
      ],
    );
    expect(plan.updates).toEqual([{ id: "f1", payload: { room_type_id: "rt-1", max_rate: 900 } }]);
    expect(plan.inserts.map((d) => d.kind)).toEqual(["zero_rate_rows"]);
    expect(plan.deletes).toEqual(["f3"]);
  });

  it("matches a closure by overlapping dates even when a one-off grew into a season", () => {
    const plan = planFindingWrites(
      [{
        kind: "closed_period",
        status: "proposed",
        payload: {
          recurring: true,
          periods: [
            { start_date: "2023-12-10", end_date: "2024-01-15" },
            { start_date: "2024-12-10", end_date: "2025-01-15" },
          ],
        },
      }],
      [open("c1", "closed_period", { start_date: "2024-12-10", end_date: "2025-01-15", days: 37 })],
    );
    expect(plan.inserts).toEqual([]);
    expect(plan.deletes).toEqual([]);
    expect(plan.updates.map((u) => u.id)).toEqual(["c1"]);
  });
});
