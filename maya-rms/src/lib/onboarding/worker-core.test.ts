import { describe, expect, it, vi } from "vitest";
import {
  historicalWindow,
  nextAfterWindow,
  processJob,
  type ImportJobRow,
  type WorkerDeps,
} from "../../../supabase/functions/_shared/onboarding/worker-core";
import type {
  AdapterCursor,
  AdapterReservationRow,
  OnboardingPmsAdapter,
} from "../../../supabase/functions/_shared/pms/onboarding-adapter";
import type { SupabaseClient } from "@supabase/supabase-js";

describe("historicalWindow", () => {
  it("window 0 is the year immediately before the anchor", () => {
    const w = historicalWindow("2026-07-26", 0);
    expect(w.from).toBe("2025-07-26");
    expect(w.to).toBe("2026-07-25");
  });

  it("window 1 is the year before that", () => {
    const w = historicalWindow("2026-07-26", 1);
    expect(w.from).toBe("2024-07-26");
    expect(w.to).toBe("2025-07-25");
  });

  it("windows tile back-to-back with no gap or overlap", () => {
    const w1 = historicalWindow("2026-07-26", 1);
    const w2 = historicalWindow("2026-07-26", 2);
    expect(w2.to < w1.from).toBe(true);
    // w2.to is exactly the day before w1.from
    const dayAfterW2To = new Date(`${w2.to}T00:00:00Z`);
    dayAfterW2To.setUTCDate(dayAfterW2To.getUTCDate() + 1);
    expect(dayAfterW2To.toISOString().slice(0, 10)).toBe(w1.from);
  });
});

describe("nextAfterWindow stop conditions", () => {
  const base = {
    window_index: 1,
    max_windows: 10,
    rows_upserted: 5000,
    row_cap: 300_000,
    windowRowCount: 1200,
  };

  it("continues while there is history and room under the cap", () => {
    expect(nextAfterWindow(base)).toEqual({ phase: "historical", reason: "more_history" });
  });

  it("stops on an empty window", () => {
    expect(nextAfterWindow({ ...base, windowRowCount: 0 }).phase).toBe("analyze");
    expect(nextAfterWindow({ ...base, windowRowCount: 0 }).reason).toBe("empty_window");
  });

  it("stops at the row cap", () => {
    expect(nextAfterWindow({ ...base, rows_upserted: 300_000 }).reason).toBe("row_cap");
  });

  it("stops at max windows", () => {
    expect(nextAfterWindow({ ...base, window_index: 10 }).reason).toBe("max_windows");
  });

  it("counts the 0-based windows so max_windows means what it says", () => {
    expect(nextAfterWindow({ ...base, window_index: 8 }).reason).toBe("more_history");
    expect(nextAfterWindow({ ...base, window_index: 9 }).reason).toBe("max_windows");
  });
});

/* ── processJob end-to-end with a mock adapter + in-memory supabase ──────── */

const TODAY = "2026-07-26";
/** What the detail sync reports it covered: its default is 30 days back. */
const COVERED_FROM = "2026-06-26";

function makeJob(overrides: Partial<ImportJobRow> = {}): ImportJobRow {
  return {
    id: "job-1",
    hotel_id: "hotel-1",
    pms_type: "cloudbeds",
    status: "running",
    phase: "discover",
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
    stats: {},
    ...overrides,
  };
}

function leaseIn(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

/**
 * What the DB does with one import_jobs update — the races lease fencing has
 * to survive. `statementDelayMs` holds the statement, so it is evaluated
 * against whatever the row holds by the time it arrives. `responseDelayMs`
 * lands the write now but holds the answer, leaving the client's token stale
 * while the row has already moved. `loseResponse` lands the write and reports
 * a transport failure, so the client never learns what it wrote.
 */
type UpdateFate = {
  statementDelayMs?: number;
  responseDelayMs?: number;
  loseResponse?: boolean;
};

/** A lease touch carries nothing but the lease itself. */
function isTouch(patch: Record<string, unknown>): boolean {
  return Object.keys(patch).every((k) => k === "lease_expires_at" || k === "updated_at");
}

/**
 * Minimal chainable stub covering the query shapes worker-core uses. The
 * import_jobs row is real state: updates apply only when their filters match
 * it, which is what makes the lease fencing observable.
 */
function makeSupabaseStub(
  jobRow: Record<string, unknown> = { id: "job-1", status: "running" },
  fateOf: (patch: Record<string, unknown>) => UpdateFate | undefined = () => undefined,
) {
  const upserts: Array<{ table: string; rows: unknown[] }> = [];
  const updates: Array<{ table: string; patch: Record<string, unknown> }> = [];
  const sleep = (ms?: number) =>
    ms ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

  function table(name: string) {
    const filters: Array<[string, string, unknown]> = [];
    let patch: Record<string, unknown> | null = null;

    const filtersMatch = () =>
      filters.every(([op, col, val]) => {
        const current = jobRow[col];
        if (op === "eq") return String(current) === String(val);
        if (op === "lte") return current != null && String(current) <= String(val);
        return true;
      });

    const settle = async () => {
      if (patch) {
        const p = patch;
        patch = null;
        const fate = (name === "import_jobs" ? fateOf(p) : undefined) ?? {};
        await sleep(fate.statementDelayMs);
        const hit = name !== "import_jobs" || filtersMatch();
        if (hit && name === "import_jobs") Object.assign(jobRow, p);
        await sleep(fate.responseDelayMs);
        if (fate.loseResponse) return { data: null, error: { message: "fetch failed" } };
        return { data: hit ? [{ id: String(jobRow.id) }] : [], error: null };
      }
      if (name === "room_types") {
        return { data: [{ id: "rt-uuid-1", external_room_type_id: "RT1" }], error: null };
      }
      return { data: [], error: null };
    };

    const chain = {
      select: () => (patch ? settle() : chain),
      eq: (col: string, val: unknown) => {
        filters.push(["eq", col, val]);
        return chain;
      },
      lte: (col: string, val: unknown) => {
        filters.push(["lte", col, val]);
        return chain;
      },
      maybeSingle: async () => {
        if (name === "hotels") return { data: { name: "X", timezone: "UTC", currency: "USD" } };
        if (name === "import_jobs") return { data: { ...jobRow }, error: null };
        return { data: null };
      },
      upsert: async (rows: unknown) => {
        upserts.push({ table: name, rows: Array.isArray(rows) ? rows : [rows] });
        return { error: null };
      },
      update: (p: Record<string, unknown>) => {
        updates.push({ table: name, patch: p });
        patch = p;
        return chain;
      },
      // Thenable so an un-selected update settles the way PostgREST does.
      then: (resolve: (value: unknown) => void, reject: (reason: unknown) => void) =>
        settle().then(resolve, reject),
    };
    return chain;
  }

  const stub = { from: table, upserts, updates, jobRow } as unknown as SupabaseClient & {
    upserts: typeof upserts;
    updates: typeof updates;
    jobRow: Record<string, unknown>;
  };
  return stub;
}

function jobPatches(supabase: { updates: Array<{ table: string; patch: Record<string, unknown> }> }) {
  return supabase.updates.filter((u) => u.table === "import_jobs");
}

function pageOfRows(count: number, stayDate: string): AdapterReservationRow[] {
  return Array.from({ length: count }, (_, i) => ({
    external_reservation_id: `res-${stayDate}-${i}`,
    external_room_type_id: "RT1",
    stay_date: stayDate,
    booking_date: null,
    booking_window_days: null,
    current_rate: 150,
    raw_payload: null,
  }));
}

type MockAdapter = OnboardingPmsAdapter & { windows: Array<{ from: string; to: string }> };

function makeAdapter(
  pagesPerWindow: Map<number, AdapterReservationRow[][]>,
  opts: { anchor?: string; onFetch?: () => void } = {},
): MockAdapter {
  const anchor = opts.anchor ?? COVERED_FROM;
  const windows: Array<{ from: string; to: string }> = [];
  return {
    windows,
    pmsType: "cloudbeds",
    capabilities: { historicalImport: true, needsDetailFetch: true },
    discoverProperty: async () => ({
      externalPropertyId: "prop-1",
      name: "Test Hotel",
      timezone: "America/New_York",
      currency: "USD",
    }),
    fetchRoomTypes: async () => [
      { external_room_type_id: "RT1", name: "King", display_name: "King", total_rooms: 10 },
    ],
    fetchReservationListPage: async (
      window: { from: string; to: string },
      cursor: AdapterCursor | null,
    ) => {
      windows.push(window);
      opts.onFetch?.();
      // Window N ends at anchor - 365N - 1 day; invert that to find N.
      const windowIndex = Math.round(
        (Date.parse(anchor) - Date.parse(window.to) - 86_400_000) / (365 * 86_400_000),
      );
      const pages = pagesPerWindow.get(windowIndex) ?? [[]];
      const pageIdx = cursor ? Number(cursor.page) : 0;
      const rows = pages[pageIdx] ?? [];
      const nextCursor =
        pageIdx + 1 < pages.length ? ({ page: pageIdx + 1 } as AdapterCursor) : null;
      return { rows, nextCursor };
    },
  };
}

function makeDeps(adapter: OnboardingPmsAdapter): WorkerDeps {
  return {
    createAdapter: async () => adapter,
    runCurrentSync: vi.fn(async () => ({ ok: true, coveredFrom: COVERED_FROM })),
    analyze: vi.fn(async () => {}),
    now: () => Date.now(),
    todayYmd: () => TODAY,
  };
}

describe("processJob", () => {
  it("runs discover -> sync_current -> historical -> analyze and completes on an empty window", async () => {
    const supabase = makeSupabaseStub();
    // Window 0 has two pages of data, window 1 is empty -> stop.
    const adapter = makeAdapter(
      new Map([
        [0, [pageOfRows(100, "2025-01-10"), pageOfRows(40, "2025-02-10")]],
        [1, [[]]],
      ]),
    );
    const deps = makeDeps(adapter);
    const job = makeJob();

    const outcome = await processJob(supabase, job, deps, 60_000);

    expect(outcome).toBe("completed");
    expect(deps.runCurrentSync).toHaveBeenCalledOnce();
    expect(deps.analyze).toHaveBeenCalledOnce();
    expect(job.rows_upserted).toBe(140);
    expect(job.stats.historyStopReason).toBe("empty_window");
    // Slim rows mapped to the room type uuid and stored with null payload
    const resUpserts = supabase.upserts.filter((u) => u.table === "reservations");
    expect(resUpserts.length).toBeGreaterThan(0);
    const firstRow = resUpserts[0].rows[0] as Record<string, unknown>;
    expect(firstRow.room_type_id).toBe("rt-uuid-1");
    expect(firstRow.raw_payload).toBeNull();
  });

  it("stops with budget_exhausted mid-window and resumes from the cursor", async () => {
    const supabase = makeSupabaseStub();
    const adapter = makeAdapter(
      new Map([
        [0, [pageOfRows(100, "2025-01-10"), pageOfRows(100, "2025-02-10")]],
        [1, [[]]],
      ]),
    );
    const deps = makeDeps(adapter);
    const job = makeJob();

    // Force the budget to blow after discover + sync_current but before
    // the historical pages run.
    let calls = 0;
    deps.now = () => {
      calls += 1;
      return calls > 3 ? 10_000_000 : 0;
    };

    const first = await processJob(supabase, job, deps, 1000);
    expect(first).toBe("budget_exhausted");
    expect(job.status).toBe("running");

    // Resume with a fresh budget: picks up from the persisted cursor/phase.
    deps.now = () => Date.now();
    const second = await processJob(supabase, job, deps, 60_000);
    expect(second).toBe("completed");
    expect(job.rows_upserted).toBe(200);
  });

  it("stops at the row cap", async () => {
    const supabase = makeSupabaseStub();
    const adapter = makeAdapter(
      new Map([
        [0, [pageOfRows(100, "2025-01-10")]],
        [1, [pageOfRows(100, "2024-01-10")]],
      ]),
    );
    const deps = makeDeps(adapter);
    const job = makeJob({ row_cap: 150 });

    const outcome = await processJob(supabase, job, deps, 60_000);
    expect(outcome).toBe("completed");
    expect(job.stats.historyStopReason).toBe("row_cap");
    expect(job.rows_upserted).toBe(200); // finished window 1, then stopped
  });

  it("stops mid-window at the row cap instead of paging forever", async () => {
    const supabase = makeSupabaseStub();
    // A cursor after every page is what a misbehaving list endpoint looks
    // like — one that ignores the page number never reaches a window
    // boundary, so the cap has to bind between pages.
    const adapter = makeAdapter(
      new Map([
        [0, [
          pageOfRows(100, "2025-01-10"),
          pageOfRows(100, "2025-01-11"),
          pageOfRows(100, "2025-01-12"),
          pageOfRows(100, "2025-01-13"),
          pageOfRows(100, "2025-01-14"),
        ]],
      ]),
    );
    const deps = makeDeps(adapter);
    const job = makeJob({ row_cap: 250 });

    const outcome = await processJob(supabase, job, deps, 60_000);

    expect(outcome).toBe("completed");
    expect(job.stats.historyStopReason).toBe("row_cap");
    expect(job.rows_upserted).toBe(300); // the page that crossed the cap, and no more
    expect(adapter.windows).toHaveLength(3);
  });

  it("marks the job failed after too many invocations that moved nothing", async () => {
    const supabase = makeSupabaseStub();
    const deps = makeDeps(makeAdapter(new Map()));
    deps.createAdapter = async () => {
      throw new Error("PMS unreachable");
    };
    const job = makeJob({ stats: { errorStreak: 49 } });

    const outcome = await processJob(supabase, job, deps, 60_000);
    expect(outcome).toBe("failed");
  });

  // A healthy import needs one claim per burst, so a big history runs up
  // hundreds of attempts. Failing on that count alone killed live imports
  // mid-history on the first transient PMS error.
  it("does not fail a long-running import just because attempts is high", async () => {
    const supabase = makeSupabaseStub();
    const deps = makeDeps(makeAdapter(new Map()));
    deps.createAdapter = async () => {
      throw new Error("Cloudbeds 502");
    };
    const job = makeJob({ attempts: 400 });

    expect(await processJob(supabase, job, deps, 60_000)).toBe("budget_exhausted");
    expect(job.stats.errorStreak).toBe(1);
  });

  // The discover upsert used to send is_active: true, so every re-import
  // undid the duplicate auto-fix and the owner's own exclusions.
  it("leaves is_active alone when refreshing room types from the PMS", async () => {
    const supabase = makeSupabaseStub();
    const adapter = makeAdapter(new Map([[0, [[]]]]));
    const job = makeJob();

    await processJob(supabase, job, makeDeps(adapter), 60_000);

    const roomTypeUpsert = supabase.upserts.find((u) => u.table === "room_types");
    const row = roomTypeUpsert?.rows[0] as Record<string, unknown>;
    expect(Object.keys(row)).not.toContain("is_active");
    // The PMS still owns naming and inventory.
    expect(row.name).toBe("King");
    expect(row.total_rooms).toBe(10);
  });
});

describe("processJob history coverage", () => {
  it("starts history where the current sync stopped, leaving no gap", async () => {
    const supabase = makeSupabaseStub();
    const adapter = makeAdapter(new Map([[0, [pageOfRows(10, "2026-05-10")]], [1, [[]]]]));
    const job = makeJob();

    await processJob(supabase, job, makeDeps(adapter), 60_000);

    // The sync covered check-ins from COVERED_FROM on; window 0 must end the
    // day before that. Anchoring on today instead left ~11 months that no
    // phase ever imported.
    expect(adapter.windows[0].to).toBe("2026-06-25");
    expect(adapter.windows[0].from).toBe("2025-06-26");
    expect(job.stats.historyAnchor).toBe(COVERED_FROM);
  });

  it("falls back to today when the sync doesn't report its window", async () => {
    const supabase = makeSupabaseStub();
    const adapter = makeAdapter(new Map([[0, [[]]]]), { anchor: TODAY });
    const deps = makeDeps(adapter);
    deps.runCurrentSync = vi.fn(async () => ({ ok: true as const, coveredFrom: null }));
    const job = makeJob();

    await processJob(supabase, job, deps, 60_000);

    // Re-covering ground the sync already has beats leaving a hole.
    expect(adapter.windows[0].to).toBe("2026-07-25");
  });

  it("keeps tiling from the recorded anchor after a resume", async () => {
    const supabase = makeSupabaseStub();
    const adapter = makeAdapter(
      new Map([[1, [pageOfRows(5, "2025-01-10")]], [2, [[]]]]),
    );
    // A job re-claimed mid-history: only the anchor and index survive.
    const job = makeJob({
      phase: "historical",
      window_index: 1,
      stats: { historyAnchor: COVERED_FROM },
    });

    await processJob(supabase, job, makeDeps(adapter), 60_000);

    expect(adapter.windows[0].to).toBe("2025-06-25");
    expect(adapter.windows[1].to).toBe("2024-06-25");
  });
});

/**
 * A job parked in sync_current whose phase outlives one heartbeat: the
 * boundary where a touch and the phase's own checkpoint can fence each other
 * out. Window 0 is empty, so once the phase transition lands the job runs
 * straight through to completion.
 */
function slowSyncSetup(fateOf: (patch: Record<string, unknown>) => UpdateFate | undefined) {
  const supabase = makeSupabaseStub(
    { id: "job-1", status: "running", phase: "sync_current", lease_expires_at: leaseIn(180_000) },
    fateOf,
  );
  const deps = makeDeps(makeAdapter(new Map([[0, [[]]]])));
  deps.runCurrentSync = () =>
    new Promise((resolve) =>
      setTimeout(() => resolve({ ok: true, coveredFrom: COVERED_FROM }), 61_000),
    );
  const job = makeJob({
    phase: "sync_current",
    lease_expires_at: String(supabase.jobRow.lease_expires_at),
  });
  return { supabase, deps, job };
}

describe("processJob lease protocol", () => {
  it("hands the lease back on budget exhaustion so the chained worker can claim it", async () => {
    const supabase = makeSupabaseStub({
      id: "job-1",
      status: "running",
      lease_expires_at: leaseIn(180_000),
    });
    const adapter = makeAdapter(
      new Map([[0, [pageOfRows(100, "2025-01-10"), pageOfRows(100, "2025-02-10")]]]),
    );
    const deps = makeDeps(adapter);
    const job = makeJob({ lease_expires_at: String(supabase.jobRow.lease_expires_at) });

    let calls = 0;
    deps.now = () => {
      calls += 1;
      return calls > 3 ? 10_000_000 : 0;
    };

    expect(await processJob(supabase, job, deps, 1000)).toBe("budget_exhausted");
    // claim_import_job takes 'running' jobs whose lease has expired — which
    // is exactly the state we must be left in for the self-chain to work.
    expect(supabase.jobRow.status).toBe("running");
    // Clearly past, not "our now": the RPC compares against the DB clock, and
    // stamping the boundary means any forward skew here skips the job.
    expect(Date.parse(String(supabase.jobRow.lease_expires_at))).toBeLessThan(Date.now() - 60_000);
  });

  it("renews the lease through a sync_current that outlives it", async () => {
    vi.useFakeTimers();
    try {
      const supabase = makeSupabaseStub({
        id: "job-1",
        status: "running",
        lease_expires_at: leaseIn(180_000),
      });
      const adapter = makeAdapter(new Map([[0, [[]]]]));
      const deps = makeDeps(adapter);
      // A property with a few thousand reservations: paced detail fetches put
      // this phase well past the 180s lease, and it has nothing to checkpoint.
      deps.runCurrentSync = () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ ok: true, coveredFrom: COVERED_FROM }), 300_000),
        );
      const job = makeJob({
        phase: "sync_current",
        lease_expires_at: String(supabase.jobRow.lease_expires_at),
      });

      const running = processJob(supabase, job, deps, 600_000);

      await vi.advanceTimersByTimeAsync(200_000);
      // Three heartbeats in, still inside the phase.
      expect(jobPatches(supabase).length).toBe(3);
      expect(Date.parse(String(supabase.jobRow.lease_expires_at))).toBeGreaterThan(Date.now());

      await vi.advanceTimersByTimeAsync(400_000);
      expect(await running).toBe("completed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops writing once another worker has re-claimed the job", async () => {
    const supabase = makeSupabaseStub({
      id: "job-1",
      status: "running",
      lease_expires_at: leaseIn(180_000),
    });
    // The re-claim lands while our page is in flight, pushing the lease out.
    const adapter = makeAdapter(
      new Map([[0, [pageOfRows(100, "2025-01-10"), pageOfRows(100, "2025-02-10")]]]),
      {
        onFetch: () => {
          supabase.jobRow.lease_expires_at = leaseIn(180_000 * 2);
        },
      },
    );
    const job = makeJob({
      phase: "historical",
      window_index: 0,
      window_from: "2025-06-26",
      window_to: "2026-06-25",
      lease_expires_at: String(supabase.jobRow.lease_expires_at),
    });

    const outcome = await processJob(supabase, job, makeDeps(adapter), 60_000);

    expect(outcome).toBe("budget_exhausted");
    // Neither the cursor nor an error message reaches the row we no longer own.
    expect(supabase.jobRow.enum_cursor).toBeUndefined();
    expect(supabase.jobRow.last_error).toBeUndefined();
    expect(supabase.jobRow.status).toBe("running");
  });

  /* Both directions of one race: a touch overlapping the checkpoint that ends
     an opaque phase. Either write can lose, and both losses are expensive —
     sync_current has nothing to resume from, so a fenced-out checkpoint re-runs
     the phase, and a touch fenced out reads as a lost lease for the rest of the
     job. */

  it("keeps the checkpoint when a touch's response is outstanding at the phase boundary", async () => {
    vi.useFakeTimers();
    try {
      const { supabase, deps, job } = slowSyncSetup((p) =>
        isTouch(p) ? { responseDelayMs: 5_000 } : undefined,
      );

      const running = processJob(supabase, job, deps, 600_000);
      await vi.advanceTimersByTimeAsync(200_000);

      expect(await running).toBe("completed");
      // The row moved on: the transition was not discarded as a lost lease.
      expect(supabase.jobRow.phase).toBe("done");
    } finally {
      vi.useRealTimers();
    }
  });

  it("completes the job when a touch reaches the row after the checkpoint overtook it", async () => {
    vi.useFakeTimers();
    try {
      const { supabase, deps, job } = slowSyncSetup((p) =>
        isTouch(p) ? { statementDelayMs: 5_000 } : undefined,
      );
      // Analyze outlives the late touch, so a lease wrongly written off lands
      // before the completion patch: the job does every bit of its work and
      // then stops short of being marked done.
      deps.analyze = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 10_000)));

      const running = processJob(supabase, job, deps, 600_000);
      await vi.advanceTimersByTimeAsync(200_000);

      expect(await running).toBe("completed");
      expect(deps.analyze).toHaveBeenCalledOnce();
      expect(supabase.jobRow.status).toBe("completed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries on when a touch lands but its response is lost in transit", async () => {
    vi.useFakeTimers();
    try {
      const { supabase, deps, job } = slowSyncSetup((p) =>
        isTouch(p) ? { loseResponse: true } : undefined,
      );

      const running = processJob(supabase, job, deps, 600_000);
      await vi.advanceTimersByTimeAsync(200_000);

      // The row holds an expiry we wrote and never heard about; reading it back
      // is the only thing that keeps the next fence from missing.
      expect(await running).toBe("completed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("abandons the job when a touch finds an expiry nobody in this isolate wrote", async () => {
    vi.useFakeTimers();
    try {
      const { supabase, deps, job } = slowSyncSetup(() => undefined);
      setTimeout(() => {
        supabase.jobRow.lease_expires_at = leaseIn(500_000);
      }, 30_000);

      const running = processJob(supabase, job, deps, 600_000);
      await vi.advanceTimersByTimeAsync(200_000);

      expect(await running).toBe("budget_exhausted");
      expect(supabase.jobRow.phase).toBe("sync_current");
      expect(supabase.jobRow.status).toBe("running");
    } finally {
      vi.useRealTimers();
    }
  });
});
