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
  it("window 1 is the year before the last 365 days", () => {
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
});

/* ── processJob end-to-end with a mock adapter + in-memory supabase ──────── */

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

/** Minimal chainable stub covering the query shapes worker-core uses. */
function makeSupabaseStub() {
  const upserts: Array<{ table: string; rows: unknown[] }> = [];
  const updates: Array<{ table: string; patch: Record<string, unknown> }> = [];

  function table(name: string) {
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () =>
        name === "hotels"
          ? { data: { name: "X", timezone: "UTC", currency: "USD" } }
          : { data: null },
      then: undefined as unknown, // guard against accidental awaiting of the chain
      upsert: async (rows: unknown) => {
        upserts.push({ table: name, rows: Array.isArray(rows) ? rows : [rows] });
        return { error: null };
      },
      update: (patch: Record<string, unknown>) => {
        updates.push({ table: name, patch });
        return chain;
      },
    };
    // select().eq() resolves to data for room_types lookups
    if (name === "room_types") {
      return {
        ...chain,
        select: () => ({
          eq: async () => ({
            data: [{ id: "rt-uuid-1", external_room_type_id: "RT1" }],
          }),
        }),
      };
    }
    return chain;
  }

  const stub = { from: table, upserts, updates } as unknown as SupabaseClient & {
    upserts: typeof upserts;
    updates: typeof updates;
  };
  return stub;
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

function makeAdapter(pagesPerWindow: Map<number, AdapterReservationRow[][]>): OnboardingPmsAdapter {
  return {
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
      // Window N ends at today - 365N - 1 day; invert that to find N.
      const windowIndex = Math.round(
        (Date.parse("2026-07-26") - Date.parse(window.to) - 86_400_000) /
          (365 * 86_400_000),
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
    runCurrentSync: vi.fn(async () => ({ ok: true })),
    analyze: vi.fn(async () => {}),
    now: () => Date.now(),
    todayYmd: () => "2026-07-26",
  };
}

describe("processJob", () => {
  it("runs discover -> sync_current -> historical -> analyze and completes on an empty window", async () => {
    const supabase = makeSupabaseStub();
    // Window 1 has two pages of data, window 2 is empty -> stop.
    const adapter = makeAdapter(
      new Map([
        [1, [pageOfRows(100, "2025-01-10"), pageOfRows(40, "2025-02-10")]],
        [2, [[]]],
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
        [1, [pageOfRows(100, "2025-01-10"), pageOfRows(100, "2025-02-10")]],
        [2, [[]]],
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
        [1, [pageOfRows(100, "2025-01-10")]],
        [2, [pageOfRows(100, "2024-01-10")]],
      ]),
    );
    const deps = makeDeps(adapter);
    const job = makeJob({ row_cap: 150 });

    const outcome = await processJob(supabase, job, deps, 60_000);
    expect(outcome).toBe("completed");
    expect(job.stats.historyStopReason).toBe("row_cap");
    expect(job.rows_upserted).toBe(200); // finished window 2, then stopped
  });

  it("marks the job failed after too many attempts", async () => {
    const supabase = makeSupabaseStub();
    const adapter = makeAdapter(new Map());
    const deps = makeDeps(adapter);
    deps.createAdapter = async () => {
      throw new Error("PMS unreachable");
    };
    const job = makeJob({ attempts: 51 });

    const outcome = await processJob(supabase, job, deps, 60_000);
    expect(outcome).toBe("failed");
  });
});
