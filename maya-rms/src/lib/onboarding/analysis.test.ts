import { describe, expect, it } from "vitest";
import {
  analyzeImport,
  findClosedPeriods,
  findDuplicateRoomTypes,
  findRateOutliers,
  findSuspectRoomTypes,
  type DailyRoomNights,
  type RoomTypeStats,
} from "../../../supabase/functions/_shared/onboarding/analysis";
import type { ImportJobRow } from "../../../supabase/functions/_shared/onboarding/worker-core";
import type { SupabaseClient } from "@supabase/supabase-js";

function seriesRange(
  from: string,
  days: number,
  nights: (i: number) => number,
): DailyRoomNights[] {
  const out: DailyRoomNights[] = [];
  const start = new Date(`${from}T00:00:00Z`);
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    const n = nights(i);
    if (n > 0) out.push({ stay_date: d.toISOString().slice(0, 10), room_nights: n });
  }
  return out;
}

describe("findClosedPeriods", () => {
  const TODAY = "2026-07-26";

  it("flags a mid-series 3-week dead zone with busy shoulders", () => {
    // 60 busy days, 21 zero days, 60 busy days
    const series = seriesRange("2025-01-01", 141, (i) =>
      i >= 60 && i < 81 ? 0 : 20,
    );
    const found = findClosedPeriods(series, TODAY);
    expect(found).toHaveLength(1);
    expect(found[0].start_date).toBe("2025-03-02");
    expect(found[0].days).toBe(21);
  });

  it("ignores short gaps", () => {
    const series = seriesRange("2025-01-01", 100, (i) => (i >= 50 && i < 60 ? 0 : 15));
    expect(findClosedPeriods(series, TODAY)).toHaveLength(0);
  });

  it("does not flag pre-opening leading zeros", () => {
    // Data starts with the first reservation — leading emptiness never appears
    // in the series, and a gap touching the series start is skipped.
    const series = seriesRange("2025-06-01", 60, (i) => (i < 20 ? 0 : 12)).filter(
      (s) => s.room_nights > 0,
    );
    expect(findClosedPeriods(series, TODAY)).toHaveLength(0);
  });

  it("does not flag a trailing gap that reaches today", () => {
    // Busy history, then silence right up to today (e.g. seasonal close ongoing)
    const series = seriesRange("2026-01-01", 150, (i) => (i < 120 ? 18 : 0));
    const found = findClosedPeriods(series, "2026-05-31");
    expect(found).toHaveLength(0);
  });

  it("requires activity on both sides", () => {
    // Zeros then busy — no 'before' activity, so not a closure
    const series = seriesRange("2025-01-01", 120, (i) => (i < 30 ? 1 : i < 60 ? 0 : 20));
    const found = findClosedPeriods(series, TODAY);
    expect(found).toHaveLength(1); // before-median is 1 (>0), so it IS flagged
    // now make the before side truly dead
    const series2 = seriesRange("2025-01-01", 120, (i) => (i === 0 ? 1 : i < 60 ? 0 : 20));
    expect(findClosedPeriods(series2, TODAY)).toHaveLength(0);
  });

  it("rescues a real closure split in half by a single stray booking", () => {
    // 90 busy, 30 zero, one comped/test night, 29 more zero, 90 busy. Without
    // bridging, each half's after/before window looks into the other half's
    // zeros and both get rejected — the 60-day closure vanishes entirely.
    const series = seriesRange("2025-01-01", 240, (i) => {
      if (i < 90) return 20;
      if (i < 120) return 0;
      if (i === 120) return 1;
      if (i < 150) return 0;
      return 20;
    });
    const found = findClosedPeriods(series, TODAY);
    expect(found).toHaveLength(1);
    expect(found[0].start_date).toBe("2025-04-01");
    expect(found[0].end_date).toBe("2025-05-30");
    expect(found[0].days).toBe(60);
  });

  it("rescues two closures separated by a too-short reopening", () => {
    // A 12-day reopening between two real closures is shorter than
    // MIN_CLOSED_RUN_DAYS, so it can't be a genuine operating stretch —
    // the fix bridges it, reporting the whole span as one closure.
    const series = seriesRange("2025-01-01", 300, (i) => {
      if (i < 50) return 15;
      if (i < 100) return 0; // 50-day closure
      if (i < 112) return 15; // 12-day reopening
      if (i < 172) return 0; // 60-day closure
      return 15;
    });
    const found = findClosedPeriods(series, TODAY);
    expect(found).toHaveLength(1);
    expect(found[0].start_date).toBe("2025-02-20");
    expect(found[0].end_date).toBe("2025-06-21");
    expect(found[0].days).toBe(122);
  });

  it("still reports two separate closures when the reopening is a genuine 15+ day stretch", () => {
    // One day longer than the previous case flips it: 15 days clears
    // MIN_CLOSED_RUN_DAYS, so it's long enough to be real — no bridging,
    // and the two closures stay distinct findings (already-correct case).
    const series = seriesRange("2025-01-01", 300, (i) => {
      if (i < 50) return 15;
      if (i < 100) return 0; // 50-day closure
      if (i < 115) return 15; // 15-day reopening
      if (i < 175) return 0; // 60-day closure
      return 15;
    });
    const found = findClosedPeriods(series, TODAY);
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ start_date: "2025-02-20", end_date: "2025-04-10", days: 50 });
    expect(found[1]).toMatchObject({ start_date: "2025-04-26", end_date: "2025-06-24", days: 60 });
  });

  it("rescues a closure with TWO stray bookings, not just one", () => {
    // Bridging a single gap isn't enough on its own — a renovation is just
    // as likely to have two stray test/comped nights as one, and a chain
    // that stops after its first bridge would suppress the closure exactly
    // as badly as having no bridging at all.
    const series = seriesRange("2025-01-01", 270, (i) => {
      if (i < 90) return 20;
      if (i < 120) return 0;
      if (i === 120) return 1;
      if (i < 149) return 0;
      if (i === 149) return 1;
      if (i < 178) return 0;
      return 20;
    });
    const found = findClosedPeriods(series, TODAY);
    expect(found).toHaveLength(1);
    expect(found[0].start_date).toBe("2025-04-01");
    expect(found[0].end_date).toBe("2025-06-27");
    expect(found[0].days).toBe(88);
  });

  it("rescues three closures split by two short reopenings", () => {
    // Same shape as the two-closure case, one more reopening added — the
    // chain has to bridge two gaps in a row, not just one.
    const series = seriesRange("2025-01-01", 350, (i) => {
      if (i < 90) return 15;
      if (i < 140) return 0; // 50-day closure
      if (i < 150) return 15; // 10-day reopening
      if (i < 200) return 0; // 50-day closure
      if (i < 210) return 15; // 10-day reopening
      if (i < 260) return 0; // 50-day closure
      return 15;
    });
    const found = findClosedPeriods(series, TODAY);
    expect(found).toHaveLength(1);
    expect(found[0].start_date).toBe("2025-04-01");
    expect(found[0].end_date).toBe("2025-09-17");
    expect(found[0].days).toBe(170);
  });

  it("does not cascade a genuinely recurring low-occupancy cadence into a false-positive closure", () => {
    // The failure mode bridging exists to avoid overcorrecting into: a
    // property with a booking every few weeks for months looks, one gap at
    // a time, identical to a closure interrupted by strays. Unbounded
    // bridging would walk the whole quiet stretch out to real business on
    // the far side and report it as one giant closure that never existed.
    const series = seriesRange("2025-01-01", 400, (i) => {
      const inQuietStretch = i >= 90 && i < 230; // ~140-day low season
      if (inQuietStretch) return (i - 90) % 23 === 0 ? 1 : 0; // a booking every ~3 weeks
      return 15;
    });
    expect(findClosedPeriods(series, TODAY)).toHaveLength(0);
  });
});

function rt(overrides: Partial<RoomTypeStats>): RoomTypeStats {
  return {
    room_type_id: "rt-1",
    external_room_type_id: "X1",
    name: "Standard King",
    is_active: true,
    row_count: 1000,
    median_rate: 150,
    p99_rate: 300,
    max_rate: 350,
    reservation_count: 400,
    single_night_reservations: 80,
    median_los: 2.5,
    ...overrides,
  };
}

describe("findSuspectRoomTypes", () => {
  it("flags by name keyword", () => {
    const found = findSuspectRoomTypes([
      rt({}),
      rt({ room_type_id: "rt-2", name: "Pickleball Court" }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].room_type_id).toBe("rt-2");
    expect(found[0].reasons[0]).toContain("bedroom");
  });

  it("uses tiny-share-at-odd-rate only to corroborate, never to accuse", () => {
    // On its own this shape is indistinguishable from a rare, pricey suite,
    // so it must not flag alone — but it should enrich a real finding.
    const alone = findSuspectRoomTypes([
      rt({ row_count: 10_000 }),
      rt({ room_type_id: "rt-2", name: "Mystery Space", row_count: 20, median_rate: 20 }),
    ]);
    expect(alone.map((f) => f.room_type_id)).not.toContain("rt-2");

    const corroborated = findSuspectRoomTypes([
      rt({ row_count: 10_000 }),
      rt({ room_type_id: "rt-3", name: "Parking Space", row_count: 20, median_rate: 20 }),
    ]);
    const hit = corroborated.find((f) => f.room_type_id === "rt-3");
    expect(hit).toBeDefined();
    expect(hit!.reasons.length).toBe(2);
  });

  it("flags all-single-night patterns when the hotel isn't", () => {
    const found = findSuspectRoomTypes([
      rt({}),
      rt({ room_type_id: "rt-2", name: "Day Room A", reservation_count: 40, single_night_reservations: 40 }),
    ]);
    expect(found.map((f) => f.room_type_id)).toContain("rt-2");
  });

  it("leaves a normal room type alone", () => {
    expect(findSuspectRoomTypes([rt({}), rt({ room_type_id: "rt-2", name: "Deluxe Queen" })])).toHaveLength(0);
  });
});

describe("findDuplicateRoomTypes", () => {
  it("deactivates the empty twin", () => {
    const found = findDuplicateRoomTypes([
      rt({ room_type_id: "keep", name: "Standard King", row_count: 900 }),
      rt({ room_type_id: "dead", name: "standard-king", row_count: 0 }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].keep_room_type_id).toBe("keep");
    expect(found[0].deactivate_room_type_id).toBe("dead");
  });

  it("leaves duplicates alone when both have bookings", () => {
    expect(
      findDuplicateRoomTypes([
        rt({ room_type_id: "a", name: "Standard King", row_count: 900 }),
        rt({ room_type_id: "b", name: "Standard King", row_count: 100 }),
      ]),
    ).toHaveLength(0);
  });
});

describe("findRateOutliers", () => {
  it("flags a max rate far beyond p99", () => {
    const found = findRateOutliers([
      rt({ max_rate: 15_000, p99_rate: 300, median_rate: 150 }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].max_rate).toBe(15_000);
  });

  it("stays quiet on thin data", () => {
    expect(
      findRateOutliers([rt({ row_count: 10, max_rate: 15_000 })]),
    ).toHaveLength(0);
  });

  it("stays quiet on normal spreads", () => {
    expect(findRateOutliers([rt({})])).toHaveLength(0);
  });

  it("still catches the fat-finger at n=50, where a contaminated p99 used to hide it", () => {
    // The exact reproduction from the review: 49 nights @ $200 plus one
    // $10,000 fat-finger. percentile_cont(0.99) at n=50 lands at ~5198 —
    // the outlier is most of what p99 IS at this sample size — so the old
    // threshold (max(p99*3, median*10) = max(15594, 2000)) sat above the
    // $10,000 max and never fired.
    const found = findRateOutliers([
      rt({ row_count: 50, median_rate: 200, p99_rate: 5198, max_rate: 10_000 }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].max_rate).toBe(10_000);
  });

  it("trusts p99 again once row_count clears MIN_ROWS_TO_TRUST_P99", () => {
    // median*10 = 2000, p99*3 = 2700: below MIN_ROWS_TO_TRUST_P99 only the
    // median term would apply and this max would be flagged; at enough rows
    // for p99 to be trustworthy, a legitimately wide (but clean) spread up
    // to 2700 should not be.
    const found = findRateOutliers([
      rt({ row_count: 250, median_rate: 200, p99_rate: 900, max_rate: 2500 }),
    ]);
    expect(found).toHaveLength(0);
  });
});

/* ── analyzeImport bookkeeping (fake client, real orchestration) ─────────── */

type Row = Record<string, unknown>;

function makeJob(stats: Row = {}): ImportJobRow {
  return {
    id: "job-1",
    hotel_id: "hotel-1",
    pms_type: "cloudbeds",
    status: "running",
    phase: "analyze",
    window_index: 0,
    window_from: null,
    window_to: null,
    enum_cursor: {},
    row_cap: 300_000,
    max_windows: 10,
    reservations_enumerated: 0,
    rows_upserted: 0,
    windows_completed: 0,
    oldest_stay_date: null,
    newest_stay_date: null,
    attempts: 1,
    stats,
  };
}

/**
 * Enough of PostgREST to run analyzeImport for real. room_types selects come
 * back empty so the guardrail/starter-rule tail short-circuits — these tests
 * are about which findings survive a re-run, not about rule generation.
 */
function makeAnalysisClient(opts: { stats: RoomTypeStats[]; findings?: Row[] }) {
  const findings: Row[] = (opts.findings ?? []).map((f) => ({ ...f }));
  const active = new Map(opts.stats.map((s) => [s.room_type_id, s.is_active]));
  const deletes: Row[] = [];

  function table(name: string) {
    const eqs: Row = {};
    let op = "select";
    let body: unknown = null;

    const matches = (row: Row) =>
      Object.entries(eqs).every(([col, val]) => String(row[col]) === String(val));

    const settle = () => {
      if (name === "onboarding_findings") {
        if (op === "delete") {
          deletes.push({ ...eqs });
          for (let i = findings.length - 1; i >= 0; i--) {
            if (matches(findings[i])) findings.splice(i, 1);
          }
          return { data: null, error: null };
        }
        if (op === "insert") {
          for (const row of body as Row[]) findings.push({ ...row });
          return { data: null, error: null };
        }
        return { data: findings.filter(matches), error: null };
      }
      if (name === "room_types") {
        if (op === "update" && typeof eqs.id === "string") {
          active.set(eqs.id, (body as Row).is_active === true);
        }
        return { data: [], error: null };
      }
      // reservations / pricing_rules counts, hotel_settings lookup.
      return { data: [], count: 0, error: null };
    };

    const chain = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        eqs[col] = val;
        return chain;
      },
      in: () => chain,
      is: () => chain,
      lte: () => chain,
      not: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => ({ data: null, error: null }),
      insert: (rows: unknown) => {
        op = "insert";
        body = Array.isArray(rows) ? rows : [rows];
        return chain;
      },
      update: (patch: Row) => {
        op = "update";
        body = patch;
        return chain;
      },
      delete: () => {
        op = "delete";
        return chain;
      },
      then: (resolve: (value: unknown) => void) => resolve(settle()),
    };
    return chain;
  }

  const client = {
    from: table,
    rpc: async (fn: string) => ({
      data: fn === "onboarding_room_type_stats" ? opts.stats : [],
      error: null,
    }),
  } as unknown as SupabaseClient;

  return {
    client,
    findings,
    deletes,
    isActive: (roomTypeId: string) => active.get(roomTypeId),
  };
}

/** "Deluxe King" plus its never-booked twin — the auto-fix's bread and butter. */
const DUPLICATE_PAIR = [
  rt({ room_type_id: "rt-keep", name: "Deluxe King", row_count: 900 }),
  rt({ room_type_id: "rt-dead", name: "Deluxe  King", row_count: 0, reservation_count: 0 }),
];

describe("analyzeImport re-runs", () => {
  it("auto-deactivates the duplicate and records it", async () => {
    const sb = makeAnalysisClient({ stats: DUPLICATE_PAIR });

    await analyzeImport(sb.client, makeJob());

    expect(sb.isActive("rt-dead")).toBe(false);
    expect(sb.findings).toHaveLength(1);
    expect(sb.findings[0].kind).toBe("duplicate_room_type");
    expect(sb.findings[0].status).toBe("auto_applied");
  });

  it("keeps the auto_applied record a re-run can no longer re-derive", async () => {
    // Anything between the deactivation and the job's completion patch can
    // throw and get the job re-claimed; analyze then runs a second time with
    // the duplicate already inactive, so the detector can't see it anymore.
    const afterFirstPass = DUPLICATE_PAIR.map((s) =>
      s.room_type_id === "rt-dead" ? { ...s, is_active: false } : s,
    );
    const sb = makeAnalysisClient({
      stats: afterFirstPass,
      findings: [
        {
          hotel_id: "hotel-1",
          job_id: "job-1",
          kind: "duplicate_room_type",
          status: "auto_applied",
          payload: { keep_room_type_id: "rt-keep", deactivate_room_type_id: "rt-dead", name: "Deluxe  King" },
        },
      ],
    });

    await analyzeImport(sb.client, makeJob());

    expect(sb.findings).toHaveLength(1);
    expect(sb.findings[0].status).toBe("auto_applied");
    // Only proposed findings are up for replacement.
    expect(sb.deletes).toEqual([{ hotel_id: "hotel-1", status: "proposed" }]);
  });

  it("replaces stale proposed findings", async () => {
    const sb = makeAnalysisClient({
      stats: DUPLICATE_PAIR,
      findings: [
        { hotel_id: "hotel-1", job_id: "old-job", kind: "rate_outlier", status: "proposed", payload: {} },
      ],
    });

    await analyzeImport(sb.client, makeJob());

    expect(sb.findings.map((f) => f.kind)).toEqual(["duplicate_room_type"]);
  });

  it("re-proposes the fix on a refresh, where nothing was applied on its behalf", async () => {
    const sb = makeAnalysisClient({
      stats: DUPLICATE_PAIR,
      findings: [
        {
          hotel_id: "hotel-1",
          job_id: "job-1",
          kind: "duplicate_room_type",
          status: "auto_applied",
          payload: { keep_room_type_id: "rt-keep", deactivate_room_type_id: "rt-dead", name: "Deluxe  King" },
        },
      ],
    });

    await analyzeImport(sb.client, makeJob({ mode: "refresh" }));

    // Refresh mode never writes, so skipping the proposal leaves the duplicate
    // active with nothing to act on: the standing record only offers Dismiss,
    // which re-activates what is already active.
    expect(sb.isActive("rt-dead")).toBe(true);
    expect(
      sb.findings.filter((f) => f.kind === "duplicate_room_type").map((f) => f.status),
    ).toEqual(["auto_applied", "proposed"]);
  });

  it("re-asserts the fix without filing a second record when the PMS hands the room type back active", async () => {
    const sb = makeAnalysisClient({
      stats: DUPLICATE_PAIR,
      findings: [
        {
          hotel_id: "hotel-1",
          job_id: "job-1",
          kind: "duplicate_room_type",
          status: "auto_applied",
          payload: { keep_room_type_id: "rt-keep", deactivate_room_type_id: "rt-dead", name: "Deluxe  King" },
        },
      ],
    });

    await analyzeImport(sb.client, makeJob());

    expect(sb.isActive("rt-dead")).toBe(false);
    expect(sb.findings).toHaveLength(1);
  });
});
