import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  pushRatesForHotel,
  resetDecidedJobs,
  type CellPushResult,
  type PmsRatePushAdapter,
  type RateCell,
  type RateTargetMap,
} from "../../../supabase/functions/_shared/pms/rate-push";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Alert } from "../../../supabase/functions/_shared/pms/alerting";
import { callTouchesColumn, fakeSupabase as rawFakeSupabase, missingColumn, missingRelation } from "../engine/fake-supabase.test";

/**
 * The engine publishes only nights the hotel has a rate on record for
 * (base-price.ts), and the push holds any other (guardrail:no_rate_on_record).
 * Unless a test says what the calendar holds, a row sits under every
 * published cell; a test that sets the table afterwards keeps the rows it
 * does not name (calendarUnder).
 */
function fakeSupabase(seed: Record<string, Row[]>, opts?: Parameters<typeof rawFakeSupabase>[1]) {
  const withCalendar = seed.base_rate_calendar ? seed : { ...seed, base_rate_calendar: calendarUnder(seed.published_price ?? []) };
  return rawFakeSupabase(withCalendar, opts);
}

/** A rate on record (100) under each published cell. */
function calendarUnder(published: Row[], except: (r: Row) => boolean = () => false): Row[] {
  return published
    .filter((p) => !except(p))
    .map((p) => ({ hotel_id: p.hotel_id ?? "hotel-1", stay_date: p.stay_date, room_type_id: p.room_type_id, price: 100 }));
}

type Row = Record<string, unknown>;

type Fixture = {
  publishedPrice?: Row[];
  roomTypes?: Row[];
  ledger?: Row[];
  connection?: Row | null;
  baseRateCalendar?: Row[];
  manualPrice?: Row[];
  /** evaluation_run_log rows, newest first. */
  evaluations?: Row[];
  /** Writing cells as failed errors, the way a dropped connection would. */
  failCorrections?: boolean;
  /** The nth rate_updates upsert (1-based) errors. */
  failLedgerWrite?: number;
};

type Chain = {
  select: () => Chain;
  eq: () => Chain;
  neq: () => Chain;
  gte: () => Chain;
  lte: () => Chain;
  is: () => Chain;
  in: () => Chain;
  order: () => Chain;
  limit: () => Chain;
  range: () => Promise<{ data: Row[]; error: null }>;
  maybeSingle: () => Promise<{ data: Row | null; error: null }>;
  upsert: (rows: Row[]) => Promise<{ error: { message: string } | null }>;
  insert: (rows: Row[]) => Promise<{ error: null }>;
  update: (patch: Row) => Chain;
};

/**
 * Minimal chainable stub covering the query shapes pushRatesForHotel uses.
 * Filters are ignored. The incident tables read empty and their writes are
 * kept apart from the ledger's (rate-push-incidents.test.ts covers them).
 */
function makeSupabaseStub(fx: Fixture) {
  const connectionUpdates: Row[] = [];
  const ledgerUpserts: Row[] = [];
  const incidentWrites: Record<string, Row[]> = {};
  let ledgerWrites = 0;
  const reads: Record<string, Row[]> = {
    published_price: fx.publishedPrice ?? [],
    room_types: fx.roomTypes ?? [],
    rate_updates: fx.ledger ?? [],
    // The engine publishes only nights with a rate on record (base-price.ts),
    // and the push holds any other: a row under every published cell unless
    // the test says what the calendar holds.
    base_rate_calendar:
      fx.baseRateCalendar ??
      (fx.publishedPrice ?? []).map((p) => ({ hotel_id: p.hotel_id, stay_date: p.stay_date, room_type_id: p.room_type_id, price: 100 })),
    manual_price: fx.manualPrice ?? [],
    evaluation_run_log: fx.evaluations ?? [],
  };

  function table(name: string): Chain {
    const chain: Chain = {
      select: () => chain,
      eq: () => chain,
      neq: () => chain,
      gte: () => chain,
      lte: () => chain,
      is: () => chain,
      in: () => chain,
      order: () => chain,
      limit: () => chain,
      range: async () => ({ data: reads[name] ?? [], error: null }),
      maybeSingle: async () => ({
        data:
          name === "hotel_settings"
            ? { simulation_mode: false }
            : name === "pms_connections"
              ? (fx.connection ?? null)
              : null,
        error: null,
      }),
      upsert: async (rows: Row[]) => {
        if (name !== "rate_updates") {
          (incidentWrites[name] ??= []).push(...rows);
          return { error: null };
        }
        ledgerWrites += 1;
        if (fx.failLedgerWrite === ledgerWrites) return { error: { message: "connection reset" } };
        if (fx.failCorrections && rows.some((r) => r.status === "failed")) {
          return { error: { message: "connection reset" } };
        }
        ledgerUpserts.push(...rows);
        return { error: null };
      },
      insert: async (rows: Row[]) => {
        (incidentWrites[name] ??= []).push(...rows);
        return { error: null };
      },
      update: (patch: Row) => {
        if (name === "pms_connections") connectionUpdates.push(patch);
        return chain;
      },
    };
    return chain;
  }

  return {
    supabase: { from: (name: string) => table(name) } as unknown as SupabaseClient,
    connectionUpdates,
    ledgerUpserts,
    incidentWrites,
  };
}

/**
 * The ledger as the upserts leave it, one row per cell: a send's
 * in-progress mark is overwritten by its outcome, and a column a write
 * leaves out keeps what was there.
 */
function finalLedger(db: { ledgerUpserts: Row[] }): Row[] {
  const byCell = new Map<string, Row>();
  for (const r of db.ledgerUpserts) {
    const key = `${r.stay_date}|${r.room_type_id}`;
    byCell.set(key, { ...byCell.get(key), ...r });
  }
  return [...byCell.values()];
}

/** `resolved` as an Error means resolveRateTargets throws, like cloudbedsGet does. */
function makeAdapter(
  resolved: RateTargetMap | Error,
  rejectExternalRoomType?: string,
): {
  adapter: PmsRatePushAdapter;
  calls: { resolve: number };
  attempts: Array<{ externalRoomTypeId: string; externalRateId: string }>;
} {
  const calls = { resolve: 0 };
  const attempts: Array<{ externalRoomTypeId: string; externalRateId: string }> = [];
  const adapter: PmsRatePushAdapter = {
    pmsType: "cloudbeds",
    async resolveRateTargets() {
      calls.resolve += 1;
      if (resolved instanceof Error) throw resolved;
      return resolved;
    },
    async pushCells(cells: Array<RateCell & { externalRateId: string }>): Promise<CellPushResult[]> {
      return cells.map((cell) => {
        attempts.push({
          externalRoomTypeId: cell.externalRoomTypeId,
          externalRateId: cell.externalRateId,
        });
        const ok = cell.externalRoomTypeId !== rejectExternalRoomType;
        return { cell, ok, jobReference: ok ? "job-1" : null, error: ok ? undefined : "rate not found" };
      });
    },
  };
  return { adapter, calls, attempts };
}

/** The schema's defaults: nobody has set a floor or a ceiling. */
const OPEN_BOUNDS = { is_active: true, floor_price: 1, ceiling_price: 99999.99 };

const ROOM_TYPES: Row[] = [
  { id: "rt-king", external_room_type_id: "CB-KING", ...OPEN_BOUNDS },
  { id: "rt-queen", external_room_type_id: "CB-QUEEN", ...OPEN_BOUNDS },
];

const ROOM_TYPES_PLUS_SUITE: Row[] = [
  ...ROOM_TYPES,
  { id: "rt-suite", external_room_type_id: "CB-SUITE", ...OPEN_BOUNDS },
];

// Priced just now, as the tick's own evaluation would have left them. The
// stub ignores the window, so the dates only need to be dates.
const JUST_NOW = new Date().toISOString();

const PRICES_TWO: Row[] = [
  { stay_date: "2026-08-01", room_type_id: "rt-king", price: 210, computed_at: JUST_NOW },
  { stay_date: "2026-08-01", room_type_id: "rt-queen", price: 180, computed_at: JUST_NOW },
];

const PRICES_THREE: Row[] = [
  ...PRICES_TWO,
  { stay_date: "2026-08-01", room_type_id: "rt-suite", price: 340, computed_at: JUST_NOW },
];

/** A window that holds every fixture night. */
const WIDE = { today: "2026-08-01", pushHorizonDays: 365 };

const CACHED_TWO: RateTargetMap = { "CB-KING": "rate-100", "CB-QUEEN": "rate-200" };

describe("pushRatesForHotel rate-target cache lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("re-resolves when a room type added after the cache was written needs a target", async () => {
    const db = makeSupabaseStub({
      publishedPrice: PRICES_THREE,
      roomTypes: ROOM_TYPES_PLUS_SUITE,
      connection: { id: "conn-1", push_rate_targets: { ...CACHED_TWO } },
    });
    const { adapter, calls, attempts } = makeAdapter({ ...CACHED_TWO, "CB-SUITE": "rate-300" });

    const summary = await pushRatesForHotel(db.supabase, "hotel-1", adapter, WIDE);

    expect(calls.resolve).toBe(1);
    expect(summary).toMatchObject({ pushed: true, sent: 3, failed: 0, skippedNoTarget: 0 });
    expect(attempts).toContainEqual({ externalRoomTypeId: "CB-SUITE", externalRateId: "rate-300" });
    expect(db.connectionUpdates).toEqual([
      { push_rate_targets: { ...CACHED_TWO, "CB-SUITE": "rate-300" } },
    ]);
  });

  it("leaves the cache alone while it covers every changed cell", async () => {
    const db = makeSupabaseStub({
      publishedPrice: PRICES_TWO,
      roomTypes: ROOM_TYPES,
      connection: { id: "conn-1", push_rate_targets: { ...CACHED_TWO } },
    });
    const { adapter, calls } = makeAdapter(CACHED_TWO);

    const summary = await pushRatesForHotel(db.supabase, "hotel-1", adapter, WIDE);

    expect(calls.resolve).toBe(0);
    expect(summary).toMatchObject({ pushed: true, sent: 2 });
    expect(db.connectionUpdates).toEqual([]);
  });

  it("drops the cache after a rejection so the next tick re-resolves the rate ids", async () => {
    const db = makeSupabaseStub({
      publishedPrice: PRICES_TWO,
      roomTypes: ROOM_TYPES,
      connection: { id: "conn-1", push_rate_targets: { ...CACHED_TWO } },
    });
    const { adapter } = makeAdapter(CACHED_TWO, "CB-KING");

    const summary = await pushRatesForHotel(db.supabase, "hotel-1", adapter, WIDE);

    expect(summary).toMatchObject({ pushed: true, sent: 1, failed: 1 });
    expect(db.connectionUpdates).toEqual([{ push_rate_targets: null }]);
    const kingLedger = finalLedger(db).find((r) => r.room_type_id === "rt-king");
    expect(kingLedger).toMatchObject({ status: "failed", error: "rate not found" });
  });

  it("keeps a working cache when the catalog read comes back empty", async () => {
    const db = makeSupabaseStub({
      publishedPrice: PRICES_THREE,
      roomTypes: ROOM_TYPES_PLUS_SUITE,
      connection: { id: "conn-1", push_rate_targets: { ...CACHED_TWO } },
    });
    const { adapter, calls } = makeAdapter({});

    const summary = await pushRatesForHotel(db.supabase, "hotel-1", adapter, WIDE);

    expect(calls.resolve).toBe(1);
    expect(summary).toMatchObject({ pushed: true, sent: 2, skippedNoTarget: 1 });
    expect(db.connectionUpdates).toEqual([]);
  });

  it("still pushes the cells the cache covers when the catalog read throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = makeSupabaseStub({
      // CB-SUITE has only derived rate plans, so it is never coverable and the
      // re-resolve is attempted on every tick.
      publishedPrice: PRICES_THREE,
      roomTypes: ROOM_TYPES_PLUS_SUITE,
      connection: { id: "conn-1", push_rate_targets: { ...CACHED_TWO } },
    });
    const { adapter, calls, attempts } = makeAdapter(new Error("Cloudbeds getRatePlans failed (500): upstream"));

    const summary = await pushRatesForHotel(db.supabase, "hotel-1", adapter, WIDE);

    expect(calls.resolve).toBe(1);
    expect(summary).toMatchObject({ pushed: true, sent: 2, failed: 0, skippedNoTarget: 1 });
    expect(attempts.map((a) => a.externalRoomTypeId)).toEqual(["CB-KING", "CB-QUEEN"]);
    expect(db.connectionUpdates).toEqual([]);
  });

  it("fails the push when the catalog read throws and there is no cache to fall back on", async () => {
    const db = makeSupabaseStub({
      publishedPrice: PRICES_TWO,
      roomTypes: ROOM_TYPES,
      connection: { id: "conn-1", push_rate_targets: null },
    });
    const { adapter } = makeAdapter(new Error("Cloudbeds getRatePlans failed (500): upstream"));

    await expect(pushRatesForHotel(db.supabase, "hotel-1", adapter, WIDE)).rejects.toThrow(/getRatePlans/);
  });

  it("does not drop targets it just resolved when the push still fails", async () => {
    const db = makeSupabaseStub({
      publishedPrice: PRICES_TWO,
      roomTypes: ROOM_TYPES,
      connection: { id: "conn-1", push_rate_targets: null },
    });
    const { adapter } = makeAdapter(CACHED_TWO, "CB-KING");

    await pushRatesForHotel(db.supabase, "hotel-1", adapter, WIDE);

    expect(db.connectionUpdates).toEqual([{ push_rate_targets: CACHED_TWO }]);
  });
});

describe("pushRatesForHotel stamps what it writes (audit A29)", () => {
  it("every ledger row of one run carries that run's id and the build, and the next run its own", async () => {
    const run = async () => {
      const db = makeSupabaseStub({ publishedPrice: PRICES_TWO, roomTypes: ROOM_TYPES, connection: { id: "conn-1", push_rate_targets: { ...CACHED_TWO } } });
      const { adapter } = makeAdapter(CACHED_TWO);
      await pushRatesForHotel(db.supabase, "hotel-1", adapter, WIDE);
      return db.ledgerUpserts;
    };
    const first = await run();
    // The in-progress marker and the outcome, for two cells.
    expect(first).toHaveLength(4);
    const runIds = new Set(first.map((r) => r.push_run_id));
    expect(runIds.size).toBe(1);
    expect([...runIds][0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(first.map((r) => r.build))).toEqual(new Set(["app@dev"]));
    const second = await run();
    expect(second[0].push_run_id).not.toBe(first[0].push_run_id);
  });
});

describe("pushRatesForHotel retry ceiling", () => {
  it("retires a cell the PMS has rejected too many times at one price", async () => {
    // Failed cells never land in lastSent, so without the ceiling this one
    // re-entered 'changed' and burned a doomed write on every tick, forever.
    const db = makeSupabaseStub({
      publishedPrice: PRICES_TWO,
      roomTypes: ROOM_TYPES,
      ledger: [
        { stay_date: "2026-08-01", room_type_id: "rt-king", price: 210, status: "failed", attempts: 10, pushed_at: new Date().toISOString() },
      ],
      connection: { id: "conn-1", push_rate_targets: { ...CACHED_TWO } },
    });
    const { adapter, attempts } = makeAdapter(CACHED_TWO);

    const summary = await pushRatesForHotel(db.supabase, "hotel-1", adapter, WIDE);

    expect(summary).toMatchObject({ pushed: true, sent: 1, failed: 0, skippedExhausted: 1 });
    expect(attempts.map((a) => a.externalRoomTypeId)).toEqual(["CB-QUEEN"]);
  });

  it("counts a repeat rejection at the same price against the ceiling", async () => {
    const db = makeSupabaseStub({
      publishedPrice: PRICES_TWO,
      roomTypes: ROOM_TYPES,
      ledger: [
        { stay_date: "2026-08-01", room_type_id: "rt-king", price: 210, status: "failed", attempts: 3 },
      ],
      connection: { id: "conn-1", push_rate_targets: { ...CACHED_TWO } },
    });
    const { adapter } = makeAdapter(CACHED_TWO, "CB-KING");

    await pushRatesForHotel(db.supabase, "hotel-1", adapter, WIDE);

    const kingLedger = finalLedger(db).find((r) => r.room_type_id === "rt-king");
    expect(kingLedger).toMatchObject({ status: "failed", attempts: 4 });
  });

  it("gives a freshly computed price its own attempts", async () => {
    const db = makeSupabaseStub({
      publishedPrice: PRICES_TWO, // king now at 210
      roomTypes: ROOM_TYPES,
      ledger: [
        // Exhausted at the OLD price — the engine moved on, so the push must too.
        { stay_date: "2026-08-01", room_type_id: "rt-king", price: 205, status: "failed", attempts: 10 },
      ],
      connection: { id: "conn-1", push_rate_targets: { ...CACHED_TWO } },
    });
    const { adapter, attempts } = makeAdapter(CACHED_TWO, "CB-KING");

    const summary = await pushRatesForHotel(db.supabase, "hotel-1", adapter, WIDE);

    expect(summary).toMatchObject({ pushed: true, failed: 1, skippedExhausted: 0 });
    expect(attempts.map((a) => a.externalRoomTypeId)).toContain("CB-KING");
    const kingLedger = finalLedger(db).find((r) => r.room_type_id === "rt-king");
    expect(kingLedger).toMatchObject({ status: "failed", attempts: 1 });
  });
});

describe("pushRatesForHotel against a deadline", () => {
  it("stops between batches once the deadline passes, and leaves the rest unrecorded for the next tick", async () => {
    const prices: Row[] = [];
    for (let d = 0; d < 365; d++) {
      const day = new Date(Date.UTC(2026, 7, 1) + d * 86_400_000).toISOString().slice(0, 10);
      prices.push(
        { stay_date: day, room_type_id: "rt-king", price: 200 + d, computed_at: JUST_NOW },
        { stay_date: day, room_type_id: "rt-queen", price: 150 + d, computed_at: JUST_NOW },
      );
    }
    const db = makeSupabaseStub({ publishedPrice: prices, roomTypes: ROOM_TYPES, connection: { id: "conn-1", push_rate_targets: CACHED_TWO } });
    const { adapter, attempts } = makeAdapter(CACHED_TWO);
    let clock = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const push = adapter.pushCells.bind(adapter);
    adapter.pushCells = async (cells) => {
      clock += 5_000; // each batch takes five seconds
      return push(cells);
    };
    const res = await pushRatesForHotel(db.supabase, "hotel-1", adapter, { ...WIDE, deadlineAt: 1_000_000 + 8_000 });
    vi.restoreAllMocks();
    // 730 changed cells in batches of 300: two batches fit, the last 130 wait.
    expect(res).toMatchObject({ pushed: true, sent: 600, deferred: 130 });
    expect(attempts).toHaveLength(600);
    // Nearest nights went first.
    expect(finalLedger(db).map((r) => r.stay_date).sort().at(-1)).toBe("2027-05-27"); // night 299 of 365
    expect(finalLedger(db)).toHaveLength(600);
  });
});

describe("pushRatesForHotel asks again about earlier jobs", () => {
  afterEach(() => resetDecidedJobs());
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

  function jobAdapter(outcomes: (refs: string[]) => Record<string, { done: boolean; ok: boolean; message?: string }>) {
    const { adapter, attempts } = makeAdapter(CACHED_TWO);
    const asked: string[][] = [];
    adapter.fetchJobOutcomes = async (refs) => {
      asked.push([...refs].sort());
      return outcomes(refs);
    };
    return { adapter, attempts, asked };
  }

  it("does not wait past the deadline for a job the vendor has not listed yet, and records the cells as sent", async () => {
    const db = makeSupabaseStub({ publishedPrice: PRICES_TWO, roomTypes: ROOM_TYPES, connection: { id: "conn-1", push_rate_targets: CACHED_TWO } });
    const { adapter, asked } = jobAdapter(() => ({}));
    const t0 = Date.now();
    const res = await pushRatesForHotel(db.supabase, "hotel-1", adapter, { ...WIDE, deadlineAt: Date.now() + 1000 });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(res).toMatchObject({ sent: 2, jobsConfirmed: 0, jobsRejected: 0 });
    expect(asked).toEqual([["job-1"]]);
    expect(finalLedger(db).map((r) => r.status)).toEqual(["sent", "sent"]);
  });

  it("flips an earlier run's cells to failed when their job turns out rejected, even with nothing new to send", async () => {
    const ledger: Row[] = [
      { stay_date: "2026-08-01", room_type_id: "rt-king", external_room_type_id: "CB-KING", price: 210, status: "sent", attempts: 1, pms_job_reference: "job-old", pushed_at: minutesAgo(10) },
      { stay_date: "2026-08-01", room_type_id: "rt-queen", external_room_type_id: "CB-QUEEN", price: 180, status: "sent", attempts: 1, pms_job_reference: "job-old", pushed_at: minutesAgo(10) },
    ];
    const db = makeSupabaseStub({ publishedPrice: PRICES_TWO, roomTypes: ROOM_TYPES, ledger, connection: { id: "conn-1", push_rate_targets: CACHED_TWO } });
    const { adapter, attempts, asked } = jobAdapter(() => ({ "job-old": { done: true, ok: false, message: "rate closed" } }));
    const res = await pushRatesForHotel(db.supabase, "hotel-1", adapter, WIDE);
    expect(attempts).toHaveLength(0);
    expect(asked).toEqual([["job-old"]]);
    expect(res).toMatchObject({ sent: 0, jobsRejected: 2 });
    expect(db.ledgerUpserts).toHaveLength(2);
    expect(db.ledgerUpserts.every((r) => r.status === "failed" && r.error === "rate closed" && r.external_room_type_id)).toBe(true);
  });

  it("leaves re-sent cells to their new job, skips synchronous refs, and stops asking after an hour", async () => {
    const ledger: Row[] = [
      // Re-sent this run at a new price: its new job decides it.
      { stay_date: "2026-08-01", room_type_id: "rt-king", external_room_type_id: "CB-KING", price: 199, status: "sent", attempts: 1, pms_job_reference: "job-old", pushed_at: minutesAgo(10) },
      { stay_date: "2026-08-01", room_type_id: "rt-queen", external_room_type_id: "CB-QUEEN", price: 180, status: "sent", attempts: 1, pms_job_reference: "accepted:200", pushed_at: minutesAgo(10) },
      { stay_date: "2026-08-02", room_type_id: "rt-queen", external_room_type_id: "CB-QUEEN", price: 180, status: "sent", attempts: 1, pms_job_reference: "job-ancient", pushed_at: minutesAgo(90) },
    ];
    const db = makeSupabaseStub({
      publishedPrice: [...PRICES_TWO, { stay_date: "2026-08-02", room_type_id: "rt-queen", price: 180, computed_at: JUST_NOW }],
      roomTypes: ROOM_TYPES,
      ledger,
      connection: { id: "conn-1", push_rate_targets: CACHED_TWO },
    });
    const { adapter, asked } = jobAdapter((refs) => Object.fromEntries(refs.map((r) => [r, { done: true, ok: false, message: "no" }])));
    const res = await pushRatesForHotel(db.supabase, "hotel-1", adapter, WIDE);
    expect(asked).toEqual([["job-1"]]);
    expect(res).toMatchObject({ sent: 1, jobsRejected: 1 });
    const failed = finalLedger(db).filter((r) => r.status === "failed");
    expect(failed.map((r) => `${r.stay_date}|${r.room_type_id}|${r.pms_job_reference}`)).toEqual(["2026-08-01|rt-king|job-1"]);
  });

  it("stops asking about an earlier job once it has been confirmed", async () => {
    const ledger: Row[] = [
      { stay_date: "2026-08-01", room_type_id: "rt-king", external_room_type_id: "CB-KING", price: 210, status: "sent", attempts: 1, pms_job_reference: "job-done", pushed_at: minutesAgo(5) },
      { stay_date: "2026-08-01", room_type_id: "rt-queen", external_room_type_id: "CB-QUEEN", price: 180, status: "sent", attempts: 1, pms_job_reference: "job-done", pushed_at: minutesAgo(5) },
    ];
    const fixture = { publishedPrice: PRICES_TWO, roomTypes: ROOM_TYPES, ledger, connection: { id: "conn-1", push_rate_targets: CACHED_TWO } };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    // The vendor lists it as applied once, then it drops off its recent list.
    let listed = true;
    const { adapter, asked } = jobAdapter((refs) =>
      listed ? Object.fromEntries(refs.map((r) => [r, { done: true, ok: true }])) : {},
    );
    const first = await pushRatesForHotel(makeSupabaseStub(fixture).supabase, "hotel-1", adapter, WIDE);
    expect(first).toMatchObject({ sent: 0, jobsConfirmed: 2 });
    expect(asked).toEqual([["job-done"]]);

    listed = false;
    const second = await pushRatesForHotel(makeSupabaseStub(fixture).supabase, "hotel-1", adapter, WIDE);
    // Not asked again and not counted twice.
    expect(asked).toHaveLength(1);
    expect(second).toMatchObject({ sent: 0 });
    expect(second).not.toHaveProperty("jobsConfirmed");

    // Nor reported unconfirmed later in the hour.
    const late = ledger.map((r) => ({ ...r, pushed_at: minutesAgo(50) }));
    await pushRatesForHotel(makeSupabaseStub({ ...fixture, ledger: late }).supabase, "hotel-1", adapter, WIDE);
    expect(asked).toHaveLength(1);
    expect(errors.mock.calls.some((c) => String(c[0]).includes("rate_job_unconfirmed"))).toBe(false);

    // Another hotel's job with the same reference is still its own question.
    await pushRatesForHotel(makeSupabaseStub(fixture).supabase, "hotel-2", adapter, WIDE);
    expect(asked).toHaveLength(2);
    errors.mockRestore();
  });

  it("asks about a rejected job again when its cells could not be stored as failed", async () => {
    const ledger: Row[] = [
      { stay_date: "2026-08-01", room_type_id: "rt-king", external_room_type_id: "CB-KING", price: 210, status: "sent", attempts: 1, pms_job_reference: "job-bad", pushed_at: minutesAgo(5) },
    ];
    const fixture = { publishedPrice: PRICES_TWO.slice(0, 1), roomTypes: ROOM_TYPES, ledger, connection: { id: "conn-1", push_rate_targets: CACHED_TWO } };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { adapter, asked } = jobAdapter(() => ({ "job-bad": { done: true, ok: false, message: "invalid rate" } }));

    await pushRatesForHotel(makeSupabaseStub({ ...fixture, failCorrections: true }).supabase, "hotel-1", adapter, WIDE);
    expect(errors.mock.calls.some((c) => String(c[0]).includes("rate_job_correction_failed"))).toBe(true);

    // The ledger still says sent, so the job is asked about again and the
    // correction written this time.
    const db = makeSupabaseStub(fixture);
    await pushRatesForHotel(db.supabase, "hotel-1", adapter, WIDE);
    expect(asked).toEqual([["job-bad"], ["job-bad"]]);
    expect(db.ledgerUpserts.filter((r) => r.status === "failed")).toHaveLength(1);

    // Once stored, it is decided and not asked about again.
    await pushRatesForHotel(makeSupabaseStub(fixture).supabase, "hotel-1", adapter, WIDE);
    expect(asked).toHaveLength(2);
    errors.mockRestore();
  });

  it("keeps asking about a job the vendor has not decided", async () => {
    const ledger: Row[] = [
      { stay_date: "2026-08-01", room_type_id: "rt-king", external_room_type_id: "CB-KING", price: 210, status: "sent", attempts: 1, pms_job_reference: "job-slow", pushed_at: minutesAgo(5) },
    ];
    const fixture = { publishedPrice: PRICES_TWO.slice(0, 1), roomTypes: ROOM_TYPES, ledger, connection: { id: "conn-1", push_rate_targets: CACHED_TWO } };
    const { adapter, asked } = jobAdapter(() => ({ "job-slow": { done: false, ok: false } }));
    await pushRatesForHotel(makeSupabaseStub(fixture).supabase, "hotel-1", adapter, WIDE);
    await pushRatesForHotel(makeSupabaseStub(fixture).supabase, "hotel-1", adapter, WIDE);
    expect(asked).toEqual([["job-slow"], ["job-slow"]]);
  });
});

describe("pushRatesForHotel pushes the hotel's own nights", () => {
  // The window is the engine's: it starts on the HOTEL's date and covers
  // exactly the horizon the tick evaluated. It used to start on the UTC date,
  // which every evening at a property west of Greenwich is already tomorrow.
  beforeEach(() => {
    vi.stubEnv("MAYA_PRICING_HORIZON_DAYS", "");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  function hotelDb(timezone: string, nights: string[]) {
    return fakeSupabase({
      hotels: [{ id: "hotel-1", timezone }],
      hotel_settings: [{ hotel_id: "hotel-1", simulation_mode: false }],
      room_types: [{ id: "rt-king", hotel_id: "hotel-1", external_room_type_id: "CB-KING", ...OPEN_BOUNDS }],
      published_price: nights.map((stay_date, i) => ({
        hotel_id: "hotel-1",
        stay_date,
        room_type_id: "rt-king",
        price: 200 + i,
        computed_at: new Date().toISOString(),
      })),
      pms_connections: [{ id: "conn-1", hotel_id: "hotel-1", pms_type: "cloudbeds", push_rate_targets: { "CB-KING": "rate-100" } }],
    });
  }

  const pushedNights = (db: ReturnType<typeof hotelDb>) =>
    (db.tables.rate_updates ?? []).filter((r) => r.status === "sent").map((r) => r.stay_date).sort();

  it("starts on tonight at a hotel still on the previous day, and ends 395 nights later", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-02T05:00:00Z")); // 22:00 on Oct 1 in Los Angeles
    const db = hotelDb("America/Los_Angeles", ["2026-09-30", "2026-10-01", "2027-10-31", "2027-11-01"]);
    const { adapter } = makeAdapter({ "CB-KING": "rate-100" });

    const res = await pushRatesForHotel(db.client, "hotel-1", adapter);

    expect(res).toMatchObject({ pushed: true, cellsConsidered: 2, sent: 2 });
    expect(pushedNights(db)).toEqual(["2026-10-01", "2027-10-31"]);
  });

  it("drops a night that is already over at a hotel ahead of UTC", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T20:00:00Z")); // 05:00 on Oct 2 in Tokyo
    const db = hotelDb("Asia/Tokyo", ["2026-10-01", "2026-10-02", "2027-11-01", "2027-11-02"]);
    const { adapter } = makeAdapter({ "CB-KING": "rate-100" });

    await pushRatesForHotel(db.client, "hotel-1", adapter);

    expect(pushedNights(db)).toEqual(["2026-10-02", "2027-11-01"]);
  });

  it("uses the tick's date and horizon when given, and asks for targets over those nights", async () => {
    const db = hotelDb("America/Los_Angeles", ["2026-10-01", "2026-10-03", "2026-10-04"]);
    db.tables.pms_connections[0].push_rate_targets = null;
    const { adapter } = makeAdapter({ "CB-KING": "rate-100" });
    const seen: unknown[] = [];
    const resolve = adapter.resolveRateTargets.bind(adapter);
    adapter.resolveRateTargets = async (opts) => (seen.push(opts), resolve(opts));

    await pushRatesForHotel(db.client, "hotel-1", adapter, { today: "2026-10-01", pushHorizonDays: 3 });

    expect(pushedNights(db)).toEqual(["2026-10-01", "2026-10-03"]);
    expect(seen).toEqual([{ today: "2026-10-01", lastNight: "2026-10-03" }]);
    // The tick already knows the date; the timezone is not read again.
    expect(db.calls.some((c) => c.table === "hotels")).toBe(false);
  });

  it("reaches as far as MAYA_PRICING_HORIZON_DAYS when no horizon is passed", async () => {
    vi.stubEnv("MAYA_PRICING_HORIZON_DAYS", "30");
    const db = hotelDb("UTC", ["2026-10-30", "2026-10-31"]);
    const { adapter } = makeAdapter({ "CB-KING": "rate-100" });

    await pushRatesForHotel(db.client, "hotel-1", adapter, { today: "2026-10-01" });

    expect(pushedNights(db)).toEqual(["2026-10-30"]);
  });
});

describe("pushRatesForHotel guardrails at the moment of sending", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const KING_ONLY = [PRICES_TWO[0]];
  const cached = { id: "conn-1", push_rate_targets: { ...CACHED_TWO } };

  it("does not send a price above the room type's ceiling, and records why", async () => {
    const db = makeSupabaseStub({
      publishedPrice: PRICES_TWO, // king 210, queen 180
      roomTypes: [
        { id: "rt-king", external_room_type_id: "CB-KING", is_active: true, floor_price: 90, ceiling_price: 200 },
        ROOM_TYPES[1],
      ],
      connection: cached,
    });
    const { adapter, attempts } = makeAdapter(CACHED_TWO);

    const res = await pushRatesForHotel(db.supabase, "hotel-1", adapter, WIDE);

    expect(attempts.map((a) => a.externalRoomTypeId)).toEqual(["CB-QUEEN"]);
    expect(res).toMatchObject({ pushed: true, sent: 1, skippedGuardrail: 1, guardrails: { "guardrail:above_ceiling": 1 } });
    expect(db.ledgerUpserts.find((r) => r.room_type_id === "rt-king")).toMatchObject({
      stay_date: "2026-08-01",
      price: 210,
      status: "skipped",
      error: "guardrail:above_ceiling",
      // Nothing was ever sent to this night.
      attempts: 0,
    });
  });

  it("holds a price under a floor raised after it was published, even with nothing else to send", async () => {
    const db = makeSupabaseStub({
      publishedPrice: KING_ONLY,
      roomTypes: [{ id: "rt-king", external_room_type_id: "CB-KING", is_active: true, floor_price: 250, ceiling_price: 900 }],
      // An earlier send sits underneath: the PMS may still hold MAYA's rate.
      ledger: [{ stay_date: "2026-08-01", room_type_id: "rt-king", price: 199, status: "sent", attempts: 1 }],
      connection: cached,
    });
    const { adapter, attempts, calls } = makeAdapter(CACHED_TWO);

    const res = await pushRatesForHotel(db.supabase, "hotel-1", adapter, WIDE);

    expect(attempts).toHaveLength(0);
    expect(calls.resolve).toBe(0);
    expect(res).toMatchObject({ sent: 0, skippedGuardrail: 1, guardrails: { "guardrail:below_floor": 1 } });
    expect(db.ledgerUpserts).toEqual([
      expect.objectContaining({ status: "skipped", error: "guardrail:below_floor", attempts: 1 }),
    ]);
  });

  it("does not send a room type that was switched off, whatever its price", async () => {
    const db = makeSupabaseStub({
      publishedPrice: PRICES_TWO,
      roomTypes: [{ ...ROOM_TYPES[0], is_active: false }, ROOM_TYPES[1]],
      connection: cached,
    });
    const { adapter, attempts } = makeAdapter(CACHED_TWO);

    const res = await pushRatesForHotel(db.supabase, "hotel-1", adapter, WIDE);

    expect(attempts.map((a) => a.externalRoomTypeId)).toEqual(["CB-QUEEN"]);
    expect(res).toMatchObject({ sent: 1, guardrails: { "guardrail:inactive_room_type": 1 } });
    expect(db.ledgerUpserts.find((r) => r.room_type_id === "rt-king")).toMatchObject({
      status: "skipped",
      error: "guardrail:inactive_room_type",
    });
  });

  it("does not push the floor onto a night the PMS has at 0, unless someone typed a price for it", async () => {
    const floorPriced = [{ stay_date: "2026-08-01", room_type_id: "rt-king", price: 89, computed_at: JUST_NOW }];
    const roomTypes = [{ id: "rt-king", external_room_type_id: "CB-KING", is_active: true, floor_price: 89, ceiling_price: 900 }];
    const closed = [{ stay_date: "2026-08-01", room_type_id: "rt-king", price: 0 }];

    const db = makeSupabaseStub({ publishedPrice: floorPriced, roomTypes, baseRateCalendar: closed, connection: cached });
    const { adapter, attempts } = makeAdapter(CACHED_TWO);
    const res = await pushRatesForHotel(db.supabase, "hotel-1", adapter, WIDE);
    expect(attempts).toHaveLength(0);
    expect(res).toMatchObject({ sent: 0, guardrails: { "guardrail:zero_base": 1 } });
    expect(db.ledgerUpserts).toEqual([expect.objectContaining({ status: "skipped", error: "guardrail:zero_base", price: 89 })]);

    // A typed price is the owner opening the night on purpose.
    const typed = makeSupabaseStub({
      publishedPrice: floorPriced,
      roomTypes,
      baseRateCalendar: closed,
      manualPrice: [{ stay_date: "2026-08-01", room_type_id: "rt-king" }],
      connection: cached,
    });
    const second = makeAdapter(CACHED_TWO);
    const typedRes = await pushRatesForHotel(typed.supabase, "hotel-1", second.adapter, WIDE);
    expect(second.attempts).toHaveLength(1);
    expect(typedRes).toMatchObject({ sent: 1, skippedGuardrail: 0 });
  });

  it("does not send a price that is not a positive number, or a night outside the window", async () => {
    const db = makeSupabaseStub({
      publishedPrice: [
        { stay_date: "2026-08-01", room_type_id: "rt-king", price: 0, computed_at: JUST_NOW },
        { stay_date: "2026-08-01", room_type_id: "rt-queen", price: -5, computed_at: JUST_NOW },
        // Yesterday, at the hotel.
        { stay_date: "2026-07-31", room_type_id: "rt-queen", price: 180, computed_at: JUST_NOW },
      ],
      roomTypes: ROOM_TYPES,
      connection: cached,
    });
    const { adapter, attempts } = makeAdapter(CACHED_TWO);

    const res = await pushRatesForHotel(db.supabase, "hotel-1", adapter, WIDE);

    expect(attempts).toHaveLength(0);
    expect(res).toMatchObject({ guardrails: { "guardrail:invalid_price": 2, "guardrail:outside_window": 1 } });
  });

  it("does not send a price nothing recent vouches for", async () => {
    const hoursAgo = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const stale = [{ stay_date: "2026-08-01", room_type_id: "rt-king", price: 210, computed_at: hoursAgo }];

    // No evaluation since: held back.
    const db = makeSupabaseStub({ publishedPrice: stale, roomTypes: ROOM_TYPES, connection: cached });
    const { adapter, attempts } = makeAdapter(CACHED_TWO);
    const res = await pushRatesForHotel(db.supabase, "hotel-1", adapter, WIDE);
    expect(attempts).toHaveLength(0);
    expect(res).toMatchObject({ guardrails: { "guardrail:stale_price": 1 } });

    // An evaluation a minute ago re-derived it, unchanged: sent.
    const recent = makeSupabaseStub({
      publishedPrice: stale,
      roomTypes: ROOM_TYPES,
      connection: cached,
      evaluations: [{ evaluated_at: new Date(Date.now() - 60_000).toISOString(), first_stay_date: "2026-08-01", last_stay_date: "2026-09-29" }],
    });
    const second = makeAdapter(CACHED_TWO);
    expect(await pushRatesForHotel(recent.supabase, "hotel-1", second.adapter, WIDE)).toMatchObject({ sent: 1 });

    // So did the tick's own evaluation, passed in.
    const passed = makeSupabaseStub({ publishedPrice: stale, roomTypes: ROOM_TYPES, connection: cached });
    const third = makeAdapter(CACHED_TWO);
    expect(
      await pushRatesForHotel(passed.supabase, "hotel-1", third.adapter, { ...WIDE, evaluatedAt: new Date().toISOString() }),
    ).toMatchObject({ sent: 1 });
  });

  it("does not rewrite a skipped row that already says the same thing", async () => {
    const db = makeSupabaseStub({
      publishedPrice: KING_ONLY,
      roomTypes: [{ ...ROOM_TYPES[0], is_active: false }],
      ledger: [
        { stay_date: "2026-08-01", room_type_id: "rt-king", price: 210, status: "skipped", attempts: 0, error: "guardrail:inactive_room_type" },
      ],
      connection: cached,
    });
    const { adapter } = makeAdapter(CACHED_TWO);

    const res = await pushRatesForHotel(db.supabase, "hotel-1", adapter, WIDE);

    expect(res).toMatchObject({ skippedGuardrail: 1 });
    expect(db.ledgerUpserts).toEqual([]);
  });
});

describe("pushRatesForHotel and room types unticked as rooms", () => {
  // The owner's $110 floor answer once landed on every active type, a $15
  // parking bay included, and the engine published $110 for the parking.
  // The floor no longer lands there (project-strategy.ts), and whatever the
  // engine publishes for a type unticked as a room is not sent unless a rule
  // of the hotel's names that type under "Change".
  afterEach(() => vi.restoreAllMocks());

  const PARKING = { id: "rt-parking", hotel_id: "hotel-1", external_room_type_id: "CB-PARK", name: "Parking", is_active: true, floor_price: 110, ceiling_price: 300 };
  const KING = { id: "rt-king", hotel_id: "hotel-1", external_room_type_id: "CB-KING", name: "King", counts_as_room: true, ...OPEN_BOUNDS };
  const TARGETS: RateTargetMap = { "CB-KING": "rate-100", "CB-PARK": "rate-900" };

  function hotel(opts: {
    parking: Row;
    rules?: Row[];
    /** Further published prices, on top of the King's and the parking bay's for 1 August. */
    published?: Row[];
    /** Open manual prices (hotel-1, not cleared, set an hour ago unless said). */
    manual?: Row[];
    fault?: Parameters<typeof fakeSupabase>[1] extends { fault?: infer F } | undefined ? F : never;
  }) {
    return fakeSupabase(
      {
        hotel_settings: [{ hotel_id: "hotel-1", simulation_mode: false }],
        room_types: [KING, opts.parking],
        pricing_rules: opts.rules ?? [],
        published_price: [
          { hotel_id: "hotel-1", stay_date: "2026-08-01", room_type_id: "rt-king", price: 210, computed_at: JUST_NOW },
          { hotel_id: "hotel-1", stay_date: "2026-08-01", room_type_id: "rt-parking", price: 110, computed_at: JUST_NOW },
          ...(opts.published ?? []).map((r) => ({ hotel_id: "hotel-1", computed_at: JUST_NOW, ...r })),
        ],
        ...(opts.manual
          ? { manual_price: opts.manual.map((r) => ({ hotel_id: "hotel-1", cleared_at: null, set_at: new Date(Date.now() - 60 * 60_000).toISOString(), ...r })) }
          : {}),
        pms_connections: [{ id: "conn-1", hotel_id: "hotel-1", pms_type: "cloudbeds", push_rate_targets: TARGETS }],
      },
      opts.fault ? { fault: opts.fault } : {},
    );
  }
  const ledger = (db: ReturnType<typeof fakeSupabase>) =>
    (db.tables.rate_updates ?? []).map((r) => ({ rt: r.room_type_id, status: r.status, error: r.error ?? null, attempts: r.attempts, price: r.price }));

  it("holds the parking bay's price back under its own code and sends the King's", async () => {
    const db = hotel({ parking: { ...PARKING, counts_as_room: false } });
    const { adapter, attempts } = makeAdapter(TARGETS);
    const res = await pushRatesForHotel(db.client, "hotel-1", adapter, WIDE);
    expect(attempts.map((a) => a.externalRoomTypeId)).toEqual(["CB-KING"]);
    expect(res).toMatchObject({ pushed: true, sent: 1, skippedGuardrail: 1, guardrails: { "guardrail:not_a_room": 1 } });
    expect(ledger(db)).toEqual(
      expect.arrayContaining([
        { rt: "rt-king", status: "sent", error: null, attempts: 1, price: 210 },
        // Nothing was ever sent to this night: the PMS keeps its own $15.
        { rt: "rt-parking", status: "skipped", error: "guardrail:not_a_room", attempts: 0, price: 110 },
      ]),
    );
    // Nothing is wrong: the PMS has its own rate for the parking bay, so no
    // incident is opened for a night MAYA never sent to.
    expect(db.tables.rate_push_incidents ?? []).toEqual([]);
  });

  it("files an admin-only incident once MAYA's own price is in the PMS for it and a rule no longer names it", async () => {
    const db = hotel({ parking: { ...PARKING, counts_as_room: false } });
    // Sent last week, while a rule named the parking bay under Change.
    db.tables.rate_updates = [
      { hotel_id: "hotel-1", pms_type: "cloudbeds", room_type_id: "rt-parking", external_room_type_id: "CB-PARK", stay_date: "2026-08-01", price: 105, status: "sent", attempts: 1, pushed_at: JUST_NOW },
    ];
    const { adapter, attempts } = makeAdapter(TARGETS);
    const res = await pushRatesForHotel(db.client, "hotel-1", adapter, WIDE);
    expect(attempts.map((a) => a.externalRoomTypeId)).toEqual(["CB-KING"]);
    expect(res).toMatchObject({ sent: 1, skippedGuardrail: 1, guardrails: { "guardrail:not_a_room": 1 } });
    expect(ledger(db)).toEqual(
      expect.arrayContaining([{ rt: "rt-parking", status: "skipped", error: "guardrail:not_a_room", attempts: 1, price: 110 }]),
    );
    expect(db.tables.rate_push_incidents ?? []).toEqual([
      expect.objectContaining({ cause: "guardrail_not_a_room", admin_only: true, severity: "transient", customer_visible_at: null }),
    ]);
  });

  it("sends the price the owner typed for a night of it, and still holds the engine's own price on its other nights", async () => {
    // The owner typed $25 for the parking bay on 2 August (the engine
    // publishes a typed price as it is). No rule names the type. Before the
    // type flag was checked at the send, the typed price went out; it still
    // does: a typed price is the owner's ask as much as a rule is.
    const db = hotel({
      parking: { ...PARKING, counts_as_room: false },
      published: [{ stay_date: "2026-08-02", room_type_id: "rt-parking", price: 25 }],
      manual: [{ stay_date: "2026-08-02", room_type_id: "rt-parking", price: 25 }],
    });
    const { adapter, attempts } = makeAdapter(TARGETS);
    const res = await pushRatesForHotel(db.client, "hotel-1", adapter, WIDE);
    expect(attempts.map((a) => a.externalRoomTypeId).sort()).toEqual(["CB-KING", "CB-PARK"]);
    expect(res).toMatchObject({ pushed: true, sent: 2, skippedGuardrail: 1, guardrails: { "guardrail:not_a_room": 1 } });
    expect(ledger(db)).toEqual(
      expect.arrayContaining([
        { rt: "rt-king", status: "sent", error: null, attempts: 1, price: 210 },
        // The engine's $110 on 1 August, which nobody asked for, stays held.
        { rt: "rt-parking", status: "skipped", error: "guardrail:not_a_room", attempts: 0, price: 110 },
        // The $25 the owner typed for 2 August went.
        { rt: "rt-parking", status: "sent", error: null, attempts: 1, price: 25 },
      ]),
    );
    expect(db.tables.rate_push_incidents ?? []).toEqual([]);
  });

  it("a typed price that was cleared no longer opens the door", async () => {
    const db = hotel({
      parking: { ...PARKING, counts_as_room: false },
      published: [{ stay_date: "2026-08-02", room_type_id: "rt-parking", price: 25 }],
      manual: [{ stay_date: "2026-08-02", room_type_id: "rt-parking", price: 25, cleared_at: JUST_NOW }],
    });
    const { adapter, attempts } = makeAdapter(TARGETS);
    const res = await pushRatesForHotel(db.client, "hotel-1", adapter, WIDE);
    expect(attempts.map((a) => a.externalRoomTypeId)).toEqual(["CB-KING"]);
    expect(res).toMatchObject({ sent: 1, skippedGuardrail: 2, guardrails: { "guardrail:not_a_room": 2 } });
  });

  it("sends it once a rule names it under Change, on or paused", async () => {
    for (const is_active of [true, false]) {
      const db = hotel({
        parking: { ...PARKING, counts_as_room: false },
        rules: [{ id: "rule-1", hotel_id: "hotel-1", is_active, rule_affected_room_type: [{ room_type_id: "rt-parking" }] }],
      });
      const { adapter, attempts } = makeAdapter(TARGETS);
      const res = await pushRatesForHotel(db.client, "hotel-1", adapter, WIDE);
      expect(attempts.map((a) => a.externalRoomTypeId).sort()).toEqual(["CB-KING", "CB-PARK"]);
      expect(res).toMatchObject({ sent: 2, skippedGuardrail: 0 });
    }
  });

  it("a rule that names only other types does not open the door", async () => {
    const db = hotel({
      parking: { ...PARKING, counts_as_room: false },
      rules: [
        { id: "rule-1", hotel_id: "hotel-1", is_active: true, rule_affected_room_type: [{ room_type_id: "rt-king" }] },
        { id: "rule-2", hotel_id: "hotel-2", is_active: true, rule_affected_room_type: [{ room_type_id: "rt-parking" }] },
      ],
    });
    const { adapter, attempts } = makeAdapter(TARGETS);
    await pushRatesForHotel(db.client, "hotel-1", adapter, WIDE);
    expect(attempts.map((a) => a.externalRoomTypeId)).toEqual(["CB-KING"]);
  });

  it("a type nobody has answered for is a room, as it is everywhere else", async () => {
    const db = hotel({ parking: { ...PARKING, counts_as_room: null } });
    const { adapter, attempts } = makeAdapter(TARGETS);
    await pushRatesForHotel(db.client, "hotel-1", adapter, WIDE);
    expect(attempts.map((a) => a.externalRoomTypeId).sort()).toEqual(["CB-KING", "CB-PARK"]);
    // No unticked type: the rules were not read.
    expect(db.calls.some((c) => c.table === "pricing_rules")).toBe(false);
  });

  it("before the counts_as_room migration the types are read again without the column, and every one is a room", async () => {
    // The column is not there, so no row carries it and the first read fails naming it.
    const db = hotel({
      parking: PARKING,
      fault: (c) => (c.table === "room_types" && callTouchesColumn(c, "counts_as_room") ? missingColumn("room_types", "counts_as_room") : null),
    });
    db.tables.room_types = [Object.fromEntries(Object.entries(KING).filter(([k]) => k !== "counts_as_room")), { ...PARKING }];
    const { adapter, attempts } = makeAdapter(TARGETS);
    const res = await pushRatesForHotel(db.client, "hotel-1", adapter, WIDE);
    expect(res).toMatchObject({ sent: 2 });
    expect(attempts.map((a) => a.externalRoomTypeId).sort()).toEqual(["CB-KING", "CB-PARK"]);
    expect(db.calls.filter((c) => c.table === "room_types" && c.op === "select")).toHaveLength(2);
    expect(db.calls.some((c) => c.table === "pricing_rules")).toBe(false);
  });

  it("stops the run when the rules cannot be read, sending nothing rather than guessing", async () => {
    const db = hotel({
      parking: { ...PARKING, counts_as_room: false },
      fault: (c) => (c.table === "pricing_rules" ? { code: "57014", message: "canceling statement due to statement timeout" } : null),
    });
    const { adapter, attempts } = makeAdapter(TARGETS);
    await expect(pushRatesForHotel(db.client, "hotel-1", adapter, WIDE)).rejects.toThrow(/statement timeout/);
    expect(attempts).toEqual([]);
    expect(db.tables.rate_updates ?? []).toEqual([]);
  });
});

describe("pushRatesForHotel keeps the ledger truthful", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const KING_PRICE = [PRICES_TWO[0]];

  function nights(count: number): Row[] {
    const out: Row[] = [];
    for (let d = 0; d < count; d++) {
      const day = new Date(Date.UTC(2026, 7, 1) + d * 86_400_000).toISOString().slice(0, 10);
      out.push({ stay_date: day, room_type_id: "rt-king", price: 200 + d, computed_at: JUST_NOW });
    }
    return out;
  }

  it("records each batch before it goes out and again once it is answered, and stops sending when a record fails", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = makeSupabaseStub({
      publishedPrice: [...nights(365), ...nights(365).map((r) => ({ ...r, room_type_id: "rt-queen" }))],
      roomTypes: ROOM_TYPES,
      connection: { id: "conn-1", push_rate_targets: CACHED_TWO },
      // Batch one is marked and answered; batch two is marked, and its answer's record fails.
      failLedgerWrite: 4,
    });
    const { adapter, attempts } = makeAdapter(CACHED_TWO);
    // What the ledger said about each batch's cells as it went out.
    const onRecord: string[][] = [];
    const push = adapter.pushCells.bind(adapter);
    adapter.pushCells = async (cells, opts) => {
      const ledger = new Map(finalLedger(db).map((r) => [`${r.stay_date}|${r.room_type_id}`, r]));
      onRecord.push([...new Set(cells.map((c) => String(ledger.get(`${c.stayDate}|${c.roomTypeId}`)?.error)))]);
      return push(cells, opts);
    };

    const res = await pushRatesForHotel(db.supabase, "hotel-1", adapter, WIDE);

    // 730 cells in batches of 300. Every cell was on record as in progress
    // before it went; the second batch's answer could not be recorded, so the
    // third never went.
    expect(onRecord).toEqual([["send in progress"], ["send in progress"]]);
    expect(attempts).toHaveLength(600);
    const ledger = finalLedger(db);
    expect(ledger.filter((r) => r.status === "sent")).toHaveLength(300);
    // The second batch is still marked, so the calendar never reads those nights back.
    expect(ledger.filter((r) => r.error === "send in progress")).toHaveLength(300);
    expect(res).toMatchObject({
      pushed: true,
      sent: 600,
      failed: 0,
      deferred: 130,
      ledgerWriteFailed: { unrecorded: 300, error: "connection reset" },
    });
    expect(errors.mock.calls.some((c) => String(c[0]).includes('"event":"rate_ledger_write_failed"'))).toBe(true);
  });

  it("sends nothing in a batch that could not be marked as in progress", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = makeSupabaseStub({
      publishedPrice: PRICES_TWO,
      roomTypes: ROOM_TYPES,
      connection: { id: "conn-1", push_rate_targets: CACHED_TWO },
      failLedgerWrite: 1,
    });
    const { adapter, attempts } = makeAdapter(CACHED_TWO);

    const res = await pushRatesForHotel(db.supabase, "hotel-1", adapter, WIDE);

    expect(attempts).toHaveLength(0);
    expect(db.ledgerUpserts).toEqual([]);
    expect(res).toMatchObject({ sent: 0, deferred: 2, ledgerWriteFailed: { unrecorded: 0, error: "connection reset" } });
    expect(errors.mock.calls.some((c) => String(c[0]).includes('"step":"pending"'))).toBe(true);
  });

  it("sends a cell again whose outcome was never recorded, without counting the lost send as a try", async () => {
    const db = makeSupabaseStub({
      publishedPrice: KING_PRICE,
      roomTypes: ROOM_TYPES,
      ledger: [
        { stay_date: "2026-08-01", room_type_id: "rt-king", price: 210, status: "failed", attempts: 0, error: "send in progress", external_rate_id: "rate-100", pushed_at: new Date(Date.now() - 5 * 60_000).toISOString() },
      ],
      connection: { id: "conn-1", push_rate_targets: CACHED_TWO },
    });
    const { adapter, attempts } = makeAdapter(CACHED_TWO);

    const res = await pushRatesForHotel(db.supabase, "hotel-1", adapter, WIDE);

    expect(attempts).toHaveLength(1);
    expect(res).toMatchObject({ sent: 1 });
    expect(finalLedger(db)).toEqual([expect.objectContaining({ status: "sent", attempts: 1, error: null })]);
  });

  it("sends nothing when the cells it holds back can't be recorded", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = makeSupabaseStub({
      // Night 366 is past the window, so a skipped row is written before any send.
      publishedPrice: nights(366),
      roomTypes: ROOM_TYPES,
      connection: { id: "conn-1", push_rate_targets: CACHED_TWO },
      failLedgerWrite: 1,
    });
    const { adapter, attempts } = makeAdapter(CACHED_TWO);

    const res = await pushRatesForHotel(db.supabase, "hotel-1", adapter, WIDE);

    expect(attempts).toHaveLength(0);
    expect(res).toMatchObject({
      sent: 0,
      skippedGuardrail: 1,
      deferred: 365,
      ledgerWriteFailed: { unrecorded: 0, error: "connection reset" },
    });
  });

  it("counts cells the adapter never started as deferred, not failed, and leaves them marked for the next tick", async () => {
    const db = makeSupabaseStub({ publishedPrice: PRICES_TWO, roomTypes: ROOM_TYPES, connection: { id: "conn-1", push_rate_targets: CACHED_TWO } });
    const { adapter } = makeAdapter(CACHED_TWO);
    const seen: unknown[] = [];
    adapter.pushCells = async (cells, opts) => {
      seen.push(opts);
      return [
        { cell: cells[0], ok: true, jobReference: "job-1" },
        { cell: cells[1], ok: false, deferred: true },
      ];
    };

    const res = await pushRatesForHotel(db.supabase, "hotel-1", adapter, { ...WIDE, deadlineAt: Date.now() + 60_000 });

    expect(seen).toEqual([{ deadlineAt: expect.any(Number) }]);
    expect(res).toMatchObject({ sent: 1, failed: 0, deferred: 1 });
    expect(finalLedger(db).map((r) => [r.room_type_id, r.status, r.error])).toEqual([
      ["rt-king", "sent", null],
      ["rt-queen", "failed", "send in progress"],
    ]);
  });

  it("keeps what a send left in the PMS: a sent price, cleared by a refusal or a rejected job, kept under a hold", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
    const night = (stay_date: string, room_type_id: string, price: number) => ({ hotel_id: "hotel-1", stay_date, room_type_id, price, computed_at: JUST_NOW });
    const db = fakeSupabase({
      hotel_settings: [{ hotel_id: "hotel-1", simulation_mode: false }],
      room_types: ROOM_TYPES.map((r) => ({ ...r, hotel_id: "hotel-1" })),
      published_price: [night("2026-08-01", "rt-king", 210), night("2026-08-01", "rt-queen", 180), night("2026-08-02", "rt-king", 220), night("2026-08-03", "rt-king", 230)],
      pms_connections: [{ id: "conn-1", hotel_id: "hotel-1", pms_type: "cloudbeds", push_rate_targets: CACHED_TWO }],
      // Night two was sent at 199 and the PMS has it at 0 now; night three's 230 went out ten minutes ago.
      base_rate_calendar: [
        { hotel_id: "hotel-1", stay_date: "2026-08-02", room_type_id: "rt-king", price: 0 },
        ...calendarUnder(
          [night("2026-08-01", "rt-king", 210), night("2026-08-01", "rt-queen", 180), night("2026-08-03", "rt-king", 230)],
        ),
      ],
      rate_updates: [
        { hotel_id: "hotel-1", stay_date: "2026-08-02", room_type_id: "rt-king", external_room_type_id: "CB-KING", price: 199, status: "sent", attempts: 1, external_rate_id: "rate-100", pms_job_reference: "job-then", sent_price: 199, pushed_at: minutesAgo(90) },
        { hotel_id: "hotel-1", stay_date: "2026-08-03", room_type_id: "rt-king", external_room_type_id: "CB-KING", price: 230, status: "sent", attempts: 1, external_rate_id: "rate-100", pms_job_reference: "job-old", sent_price: 230, pushed_at: minutesAgo(10) },
      ],
    });
    const { adapter } = makeAdapter(CACHED_TWO);
    adapter.pushCells = async (cells) =>
      cells.map((cell) =>
        cell.externalRoomTypeId === "CB-QUEEN"
          ? { cell, ok: false, error: "Cloudbeds patchRate failed (400): Rate must be greater than 500", httpStatus: 400 }
          : { cell, ok: true, jobReference: "job-1" },
      );
    adapter.fetchJobOutcomes = async (refs) =>
      Object.fromEntries(refs.map((r) => [r, r === "job-old" ? { done: true, ok: false, message: "rate closed" } : { done: true, ok: true }]));

    await pushRatesForHotel(db.client, "hotel-1", adapter, WIDE);
    resetDecidedJobs();

    const row = (stay: string, room: string) => db.tables.rate_updates.find((r) => r.stay_date === stay && r.room_type_id === room);
    expect(row("2026-08-01", "rt-king")).toMatchObject({ status: "sent", price: 210, sent_price: 210 });
    expect(row("2026-08-01", "rt-queen")).toMatchObject({ status: "failed", sent_price: null });
    expect(row("2026-08-02", "rt-king")).toMatchObject({ status: "skipped", error: "guardrail:zero_base", price: 220, sent_price: 199 });
    expect(row("2026-08-03", "rt-king")).toMatchObject({ status: "failed", error: "rate closed", sent_price: null });
    // PostgREST writes null into a column one row of a chunk has and another leaves out.
    for (const c of db.calls.filter((c) => c.table === "rate_updates" && c.op === "upsert")) {
      const shapes = new Set((c.payload as Row[]).map((r) => Object.keys(r).sort().join(",")));
      expect(shapes.size).toBe(1);
    }
  });

  it("writes its ledger rows without sent_price on a database that does not have it yet", async () => {
    const db = fakeSupabase(
      {
        hotel_settings: [{ hotel_id: "hotel-1", simulation_mode: false }],
        room_types: ROOM_TYPES.map((r) => ({ ...r, hotel_id: "hotel-1" })),
        published_price: PRICES_TWO.map((r) => ({ ...r, hotel_id: "hotel-1" })),
        pms_connections: [{ id: "conn-1", hotel_id: "hotel-1", pms_type: "cloudbeds", push_rate_targets: CACHED_TWO }],
      },
      { fault: (c) => (c.table === "rate_updates" && c.op === "upsert" && callTouchesColumn(c, "sent_price") ? missingColumn("rate_updates", "sent_price") : null) },
    );
    const { adapter } = makeAdapter(CACHED_TWO, "CB-QUEEN");

    const res = await pushRatesForHotel(db.client, "hotel-1", adapter, WIDE);

    expect(res).toMatchObject({ sent: 1, failed: 1 });
    expect(res).not.toHaveProperty("ledgerWriteFailed");
    expect(db.tables.rate_updates.map((r) => [r.room_type_id, r.status, "sent_price" in r])).toEqual([
      ["rt-king", "sent", false],
      ["rt-queen", "failed", false],
    ]);
  });

  it("stores at most 300 characters of a vendor's error", async () => {
    const db = makeSupabaseStub({ publishedPrice: KING_PRICE, roomTypes: ROOM_TYPES, connection: { id: "conn-1", push_rate_targets: CACHED_TWO } });
    const { adapter } = makeAdapter(CACHED_TWO);
    adapter.pushCells = async (cells) => cells.map((cell) => ({ cell, ok: false, error: "x".repeat(2000) }));

    await pushRatesForHotel(db.supabase, "hotel-1", adapter, WIDE);

    expect(finalLedger(db)).toEqual([expect.objectContaining({ status: "failed", error: "x".repeat(300) })]);
  });

  it("starts no batch once the deadline has passed", async () => {
    const db = makeSupabaseStub({ publishedPrice: PRICES_TWO, roomTypes: ROOM_TYPES, connection: { id: "conn-1", push_rate_targets: CACHED_TWO } });
    const { adapter, attempts } = makeAdapter(CACHED_TWO);

    const res = await pushRatesForHotel(db.supabase, "hotel-1", adapter, { ...WIDE, deadlineAt: Date.now() - 1 });

    expect(attempts).toHaveLength(0);
    expect(res).toMatchObject({ sent: 0, failed: 0, deferred: 2 });
    expect(db.ledgerUpserts).toEqual([]);
  });

  it("says so when the cached targets can't be written or dropped", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = makeSupabaseStub({ publishedPrice: PRICES_TWO, roomTypes: ROOM_TYPES, connection: { id: "conn-1", push_rate_targets: null } });
    const failing = db.supabase.from;
    (db.supabase as unknown as { from: (t: string) => unknown }).from = (t: string) => {
      const chain = failing(t) as unknown as { update: (p: Row) => unknown };
      if (t !== "pms_connections") return chain;
      return {
        ...chain,
        update: () => ({ eq: async () => ({ error: { message: "permission denied" } }) }),
      };
    };
    const { adapter } = makeAdapter(CACHED_TWO);

    const res = await pushRatesForHotel(db.supabase, "hotel-1", adapter, WIDE);

    expect(res).toMatchObject({ sent: 2 });
    expect(errors.mock.calls.some((c) => String(c[0]).includes('"event":"rate_targets_write_failed"'))).toBe(true);
  });
});

describe("pushRatesForHotel retries by cause", () => {
  afterEach(() => {
    resetDecidedJobs();
    vi.restoreAllMocks();
  });
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const VALUE_REFUSED = "Cloudbeds patchRate failed (400): Rate must be greater than 500";
  const OUTAGE = "Cloudbeds patchRate failed (503): Service Unavailable";

  /** Every cell for `room` is refused with `error` (and `httpStatus`). */
  function refusing(room: string, error: string, httpStatus: number | null = null) {
    const made = makeAdapter(CACHED_TWO);
    made.adapter.pushCells = async (cells) =>
      cells.map((cell) => {
        made.attempts.push({ externalRoomTypeId: cell.externalRoomTypeId, externalRateId: cell.externalRateId });
        return cell.externalRoomTypeId === room
          ? { cell, ok: false, error, httpStatus }
          : { cell, ok: true, jobReference: "job-1" };
      });
    return made;
  }

  it("carries a send's tries into a job rejection, for this run's jobs and earlier ones", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = makeSupabaseStub({
      publishedPrice: [...PRICES_TWO, { stay_date: "2026-08-02", room_type_id: "rt-queen", price: 180, computed_at: JUST_NOW }],
      roomTypes: ROOM_TYPES,
      ledger: [
        // Refused four times at this price by an outage; this run sends it again.
        { stay_date: "2026-08-01", room_type_id: "rt-king", price: 210, status: "failed", attempts: 4, error: OUTAGE, pushed_at: minutesAgo(5) },
        // Went out on an earlier run after three tries; its job is still open.
        { stay_date: "2026-08-02", room_type_id: "rt-queen", external_room_type_id: "CB-QUEEN", price: 180, status: "sent", attempts: 3, pms_job_reference: "job-old", pushed_at: minutesAgo(10) },
      ],
      connection: { id: "conn-1", push_rate_targets: CACHED_TWO },
    });
    const { adapter } = makeAdapter(CACHED_TWO);
    adapter.fetchJobOutcomes = async (refs) => Object.fromEntries(refs.map((r) => [r, { done: true, ok: false, message: "rate closed" }]));

    const res = await pushRatesForHotel(db.supabase, "hotel-1", adapter, WIDE);

    expect(res).toMatchObject({ sent: 2, jobsRejected: 3 });
    const corrected = (night: string, room: string) =>
      db.ledgerUpserts.filter((r) => r.stay_date === night && r.room_type_id === room && r.status === "failed").at(-1);
    expect(db.ledgerUpserts.find((r) => r.room_type_id === "rt-king" && r.status === "sent")).toMatchObject({ attempts: 5 });
    expect(corrected("2026-08-01", "rt-king")).toMatchObject({ attempts: 5, error: "rate closed" });
    expect(corrected("2026-08-01", "rt-queen")).toMatchObject({ attempts: 1 });
    expect(corrected("2026-08-02", "rt-queen")).toMatchObject({ attempts: 3, pms_job_reference: "job-old" });
  });

  it("rests a cell whose jobs keep being rejected, instead of re-sending it every tick", async () => {
    const db = makeSupabaseStub({
      publishedPrice: PRICES_TWO,
      roomTypes: ROOM_TYPES,
      ledger: [
        { stay_date: "2026-08-01", room_type_id: "rt-king", price: 210, status: "failed", attempts: 10, error: "rate closed", pms_job_reference: "job-9", pushed_at: minutesAgo(5) },
      ],
      connection: { id: "conn-1", push_rate_targets: CACHED_TWO },
    });
    const { adapter, attempts } = makeAdapter(CACHED_TWO);

    const res = await pushRatesForHotel(db.supabase, "hotel-1", adapter, WIDE);

    expect(res).toMatchObject({ sent: 1, skippedExhausted: 1 });
    expect(attempts.map((a) => a.externalRoomTypeId)).toEqual(["CB-QUEEN"]);
  });

  it("tries a cell that used its tries again once a day has passed", async () => {
    const db = makeSupabaseStub({
      publishedPrice: PRICES_TWO,
      roomTypes: ROOM_TYPES,
      ledger: [
        { stay_date: "2026-08-01", room_type_id: "rt-king", price: 210, status: "failed", attempts: 10, error: OUTAGE, pushed_at: minutesAgo(25 * 60) },
      ],
      connection: { id: "conn-1", push_rate_targets: CACHED_TWO },
    });
    const { adapter, attempts } = refusing("CB-KING", OUTAGE, 503);

    const res = await pushRatesForHotel(db.supabase, "hotel-1", adapter, WIDE);

    expect(res).toMatchObject({ sent: 1, failed: 1, skippedExhausted: 0 });
    expect(attempts.map((a) => a.externalRoomTypeId)).toContain("CB-KING");
    // Rests for another day straight away.
    expect(finalLedger(db).find((r) => r.room_type_id === "rt-king")).toMatchObject({ status: "failed", attempts: 11 });
  });

  it("holds a cell refused for a known critical cause from the first refusal, until its price changes", async () => {
    const ledger: Row[] = [
      { stay_date: "2026-08-01", room_type_id: "rt-king", price: 210, status: "failed", attempts: 1, error: VALUE_REFUSED, external_rate_id: "rate-100", pushed_at: minutesAgo(5) },
    ];
    const held = makeSupabaseStub({ publishedPrice: PRICES_TWO, roomTypes: ROOM_TYPES, ledger, connection: { id: "conn-1", push_rate_targets: CACHED_TWO } });
    const first = makeAdapter(CACHED_TWO);
    expect(await pushRatesForHotel(held.supabase, "hotel-1", first.adapter, WIDE)).toMatchObject({ sent: 1, skippedHeld: 1, skippedExhausted: 0 });
    expect(first.attempts.map((a) => a.externalRoomTypeId)).toEqual(["CB-QUEEN"]);

    const repriced = makeSupabaseStub({
      publishedPrice: [{ ...PRICES_TWO[0], price: 520 }, PRICES_TWO[1]],
      roomTypes: ROOM_TYPES,
      ledger,
      connection: { id: "conn-1", push_rate_targets: CACHED_TWO },
    });
    const second = makeAdapter(CACHED_TWO);
    const res = await pushRatesForHotel(repriced.supabase, "hotel-1", second.adapter, WIDE);
    expect(res).toMatchObject({ sent: 2 });
    expect(res).not.toHaveProperty("skippedHeld");
  });

  it("lets a held cell go when its room type now maps to a different rate", async () => {
    const db = makeSupabaseStub({
      publishedPrice: PRICES_TWO,
      roomTypes: ROOM_TYPES,
      ledger: [
        { stay_date: "2026-08-01", room_type_id: "rt-king", price: 210, status: "failed", attempts: 2, error: "Cloudbeds patchRate failed (400): Invalid rateID", external_rate_id: "rate-gone", pushed_at: minutesAgo(5) },
      ],
      connection: { id: "conn-1", push_rate_targets: CACHED_TWO },
    });
    const { adapter, attempts } = makeAdapter(CACHED_TWO);

    const res = await pushRatesForHotel(db.supabase, "hotel-1", adapter, WIDE);

    expect(res).toMatchObject({ sent: 2 });
    expect(attempts).toContainEqual({ externalRoomTypeId: "CB-KING", externalRateId: "rate-100" });
  });

  it("keeps the cached targets through an outage or a refused value", async () => {
    for (const [error, status] of [
      [OUTAGE, 503],
      [VALUE_REFUSED, 400],
    ] as const) {
      const db = makeSupabaseStub({ publishedPrice: PRICES_TWO, roomTypes: ROOM_TYPES, connection: { id: "conn-1", push_rate_targets: CACHED_TWO } });
      const { adapter } = refusing("CB-KING", error, status);
      expect(await pushRatesForHotel(db.supabase, "hotel-1", adapter, WIDE)).toMatchObject({ failed: 1 });
      expect(db.connectionUpdates).toEqual([]);
    }
  });

  it("takes a job the vendor still lists as unfinished after 45 minutes as not applied, so the cell goes out again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ledger: Row[] = [
      { stay_date: "2026-08-01", room_type_id: "rt-king", external_room_type_id: "CB-KING", price: 210, status: "sent", attempts: 1, pms_job_reference: "job-stuck", pushed_at: minutesAgo(50) },
    ];
    const db = makeSupabaseStub({ publishedPrice: PRICES_TWO.slice(0, 1), roomTypes: ROOM_TYPES, ledger, connection: { id: "conn-1", push_rate_targets: CACHED_TWO } });
    const { adapter } = makeAdapter(CACHED_TWO);
    adapter.fetchJobOutcomes = async () => ({ "job-stuck": { done: false, ok: false } });

    const res = await pushRatesForHotel(db.supabase, "hotel-1", adapter, WIDE);

    expect(res).toMatchObject({ sent: 0, jobsRejected: 0, jobsUnconfirmed: 1 });
    expect(db.ledgerUpserts).toEqual([
      expect.objectContaining({ status: "failed", error: "rate job never confirmed", pms_job_reference: "job-stuck", attempts: 1 }),
    ]);
  });

  it("leaves a job missing from the vendor's list as sent: it may just have been confirmed and dropped off", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const ledger: Row[] = [
      { stay_date: "2026-08-01", room_type_id: "rt-king", external_room_type_id: "CB-KING", price: 210, status: "sent", attempts: 1, pms_job_reference: "job-gone", pushed_at: minutesAgo(50) },
    ];
    const db = makeSupabaseStub({ publishedPrice: PRICES_TWO.slice(0, 1), roomTypes: ROOM_TYPES, ledger, connection: { id: "conn-1", push_rate_targets: CACHED_TWO } });
    const { adapter } = makeAdapter(CACHED_TWO);
    adapter.fetchJobOutcomes = async () => ({});

    const res = await pushRatesForHotel(db.supabase, "hotel-1", adapter, WIDE);

    expect(res).not.toHaveProperty("jobsUnconfirmed");
    expect(db.ledgerUpserts).toEqual([]);
    expect(errors.mock.calls.some((c) => String(c[0]).includes('"event":"rate_job_unconfirmed"'))).toBe(true);
  });
});

describe("pushRatesForHotel files failures as incidents", () => {
  function liveHotel(price: number, ledger: Row[] = []) {
    return fakeSupabase({
      hotel_settings: [{ hotel_id: "hotel-1", simulation_mode: false }],
      room_types: [{ id: "rt-king", hotel_id: "hotel-1", external_room_type_id: "CB-KING", ...OPEN_BOUNDS }],
      published_price: [{ hotel_id: "hotel-1", stay_date: "2026-08-01", room_type_id: "rt-king", price, computed_at: new Date().toISOString() }],
      pms_connections: [{ id: "conn-1", hotel_id: "hotel-1", pms_type: "cloudbeds", push_rate_targets: { "CB-KING": "rate-100" } }],
      rate_updates: ledger,
    });
  }
  const incidentCalls = (db: ReturnType<typeof liveHotel>) => db.calls.filter((c) => c.table.startsWith("rate_push_"));

  it("makes one small incident read on a clean run with nothing failing on record", async () => {
    const db = liveHotel(210);
    const { adapter } = makeAdapter({ "CB-KING": "rate-100" });

    const res = await pushRatesForHotel(db.client, "hotel-1", adapter, WIDE);

    expect(res).toMatchObject({ sent: 1 });
    expect(res).not.toHaveProperty("incidents");
    expect(incidentCalls(db)).toEqual([expect.objectContaining({ table: "rate_push_incidents", op: "select", columns: "id" })]);
  });

  it("opens an incident for a refused price, shows it to the owner, and closes it when a new price lands", async () => {
    const db = liveHotel(210);
    const refused = makeAdapter({ "CB-KING": "rate-100" });
    refused.adapter.pushCells = async (cells) =>
      cells.map((cell) => ({ cell, ok: false, error: "Cloudbeds patchRate failed (400): Rate must be greater than 500", httpStatus: 400 }));

    const first = await pushRatesForHotel(db.client, "hotel-1", refused.adapter, WIDE);

    expect(first).toMatchObject({ failed: 1, incidents: { opened: 1, escalated: 1 } });
    expect(db.tables.rate_push_incidents).toEqual([
      expect.objectContaining({ hotel_id: "hotel-1", cause: "value_rejected", severity: "critical", resolved_at: null }),
    ]);
    expect(db.tables.rate_push_incidents[0].customer_visible_at).not.toBeNull();
    expect(db.tables.rate_push_attempts).toEqual([
      expect.objectContaining({ phase: "send", outcome: "failed", http_status: 400, price: 210, stay_date: "2026-08-01", room_type_id: "rt-king" }),
    ]);

    // Held at that price: nothing is sent and the incident stays open.
    const held = await pushRatesForHotel(db.client, "hotel-1", makeAdapter({ "CB-KING": "rate-100" }).adapter, WIDE);
    expect(held).toMatchObject({ sent: 0, skippedHeld: 1 });
    expect(db.tables.rate_push_incidents[0].resolved_at).toBeNull();

    // The engine moves the price and it lands.
    db.tables.published_price[0].price = 520;
    const landed = await pushRatesForHotel(db.client, "hotel-1", makeAdapter({ "CB-KING": "rate-100" }).adapter, WIDE);
    expect(landed).toMatchObject({ sent: 1, incidents: { resolved: 1 } });
    expect(db.tables.rate_push_incidents[0]).toMatchObject({ resolution: "superseded" });

    // Nothing failing or open any more: back to the one small read.
    const before = incidentCalls(db).length;
    db.tables.published_price[0].price = 530;
    await pushRatesForHotel(db.client, "hotel-1", makeAdapter({ "CB-KING": "rate-100" }).adapter, WIDE);
    expect(incidentCalls(db).slice(before)).toEqual([expect.objectContaining({ table: "rate_push_incidents", columns: "id" })]);
  });

  it("files a room type whose only rates follow another plan under that cause", async () => {
    const db = liveHotel(210);
    const { adapter } = makeAdapter({ "CB-QUEEN": "rate-200" });
    adapter.missingTargetReason = (ext) => (ext === "CB-KING" ? "derived_only" : null);
    db.tables.pms_connections[0].push_rate_targets = null;

    const res = await pushRatesForHotel(db.client, "hotel-1", adapter, WIDE);

    expect(res).toMatchObject({ skippedNoTarget: 1, incidents: { opened: 1 } });
    expect(db.tables.rate_push_incidents[0]).toMatchObject({ cause: "rate_plan_not_updatable", admin_only: false });
    expect(db.tables.rate_push_attempts[0]).toMatchObject({ phase: "guardrail", outcome: "skipped", message: "no rate target for room type" });
  });

  it("never lets recording undo a push", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = fakeSupabase(
      {
        hotel_settings: [{ hotel_id: "hotel-1", simulation_mode: false }],
        room_types: [{ id: "rt-king", hotel_id: "hotel-1", external_room_type_id: "CB-KING", ...OPEN_BOUNDS }],
        published_price: [{ hotel_id: "hotel-1", stay_date: "2026-08-01", room_type_id: "rt-king", price: 210, computed_at: new Date().toISOString() }],
        pms_connections: [{ id: "conn-1", hotel_id: "hotel-1", pms_type: "cloudbeds", push_rate_targets: { "CB-KING": "rate-100" } }],
      },
      { fault: (c) => (c.table.startsWith("rate_push_") ? missingRelation(c.table) : null) },
    );
    const { adapter } = makeAdapter({ "CB-KING": "rate-100" }, "CB-KING");

    const res = await pushRatesForHotel(db.client, "hotel-1", adapter, WIDE);

    expect(res).toMatchObject({ pushed: true, failed: 1, incidents: { error: expect.stringContaining("rate_push_incidents") } });
    expect(db.tables.rate_updates).toEqual([expect.objectContaining({ status: "failed" })]);
    errors.mockRestore();
  });
});

describe("pushRatesForHotel and nights that wait on a read of the hotel's rates", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const T0 = new Date("2026-08-01T10:00:00Z");
  const NIGHTS = ["2026-08-01", "2026-08-02", "2026-08-03"];

  /** A hotel that has just gone live: three nights published, nothing ever sent. */
  function justLive() {
    return fakeSupabase({
      hotel_settings: [{ hotel_id: "hotel-1", simulation_mode: false }],
      room_types: [{ id: "rt-king", hotel_id: "hotel-1", external_room_type_id: "CB-KING", name: "King", ...OPEN_BOUNDS }],
      published_price: NIGHTS.map((stay_date) => ({
        hotel_id: "hotel-1",
        stay_date,
        room_type_id: "rt-king",
        price: 210,
        computed_at: T0.toISOString(),
      })),
      pms_connections: [{ id: "conn-1", hotel_id: "hotel-1", pms_type: "cloudbeds", push_rate_targets: { "CB-KING": "rate-100" } }],
      rate_updates: [],
    });
  }
  const alerts: Alert[] = [];
  /** One tick, `minutes` after the hotel went live, with or without a rate read to go on. */
  async function tick(db: ReturnType<typeof justLive>, minutes: number, rateReadWorked: boolean) {
    vi.setSystemTime(new Date(T0.getTime() + minutes * 60_000));
    const { adapter, attempts } = makeAdapter({ "CB-KING": "rate-100" });
    const res = await pushRatesForHotel(db.client, "hotel-1", adapter, {
      ...WIDE,
      evaluatedAt: new Date().toISOString(),
      holdNeverPushed: !rateReadWorked,
    });
    return { res, attempts };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    alerts.length = 0;
    process.env.MAYA_ALERT_WEBHOOK = "https://hooks.example.test/maya";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        alerts.push(JSON.parse(init.body));
        return new Response("ok", { status: 200 });
      }),
    );
  });
  afterEach(() => {
    delete process.env.MAYA_ALERT_WEBHOOK;
    vi.unstubAllGlobals();
  });

  it("files the held nights once, tells nobody for the first hour, then tells the owner and the alert channel", async () => {
    const db = justLive();

    const first = await tick(db, 0, false);

    expect(first.attempts).toEqual([]);
    expect(first.res).toMatchObject({ pushed: true, sent: 0, awaitingBaseRead: 3, incidents: { opened: 1, escalated: 0 } });
    expect(db.tables.rate_push_incidents).toEqual([
      expect.objectContaining({ cause: "awaiting_rate_read", admin_only: false, customer_visible_at: null, alerted_at: null, resolved_at: null }),
    ]);
    expect(db.tables.rate_push_incident_cells.map((c) => [c.stay_date, c.state])).toEqual(NIGHTS.map((n) => [n, "open"]));
    expect(db.tables.rate_push_attempts).toHaveLength(3);
    expect(db.tables.rate_push_attempts[0]).toMatchObject({ phase: "guardrail", outcome: "skipped", message: "awaiting rate read" });
    // The ledger holds nothing for them: they are still nights MAYA never sent to.
    expect(db.tables.rate_updates).toEqual([]);

    // Every five minutes for the rest of the hour: still held, nothing more written.
    for (let minutes = 5; minutes < 60; minutes += 5) {
      const writesBefore = db.calls.filter((c) => c.op !== "select").length;
      const again = await tick(db, minutes, false);
      expect(again.res).toMatchObject({ sent: 0, awaitingBaseRead: 3 });
      expect(db.calls.filter((c) => c.op !== "select").length).toBe(writesBefore);
    }
    expect(db.tables.rate_push_attempts).toHaveLength(3);
    expect(db.tables.rate_push_incidents[0].customer_visible_at).toBeNull();
    expect(alerts).toEqual([]);

    // An hour on.
    const later = await tick(db, 60, false);

    expect(later.res).toMatchObject({ sent: 0, awaitingBaseRead: 3, incidents: { escalated: 1 } });
    expect(db.tables.rate_push_incidents[0]).toMatchObject({ cause: "awaiting_rate_read", resolved_at: null });
    expect(db.tables.rate_push_incidents[0].customer_visible_at).not.toBeNull();
    expect(db.tables.rate_push_incidents[0].alerted_at).not.toBeNull();
    expect(alerts).toEqual([
      expect.objectContaining({ severity: "critical", key: "rate_push:awaiting_rate_read:hotel-1", hotelId: "hotel-1" }),
    ]);

    // And it is said once, not every five minutes after.
    await tick(db, 65, false);
    await tick(db, 70, false);
    expect(alerts).toHaveLength(1);
    expect(db.tables.rate_updates).toEqual([]);
  });

  it("sends the nights and closes the problem on the first tick whose rate read works", async () => {
    const db = justLive();
    await tick(db, 0, false);
    await tick(db, 60, false);
    expect(db.tables.rate_push_incidents[0].customer_visible_at).not.toBeNull();

    const sent = await tick(db, 65, true);

    expect(sent.attempts).toHaveLength(3);
    expect(sent.res).toMatchObject({ sent: 3, incidents: { resolved: 1 } });
    expect(sent.res).not.toHaveProperty("awaitingBaseRead");
    expect(db.tables.rate_push_incidents[0]).toMatchObject({ resolution: "landed" });
    expect(db.tables.rate_push_incidents[0].resolved_at).not.toBeNull();
    expect(db.tables.rate_push_incident_cells.every((c) => c.state === "landed")).toBe(true);
    expect(db.tables.rate_updates.map((r) => [r.stay_date, r.status, r.price])).toEqual(NIGHTS.map((n) => [n, "sent", 210]));
  });

  it("says nothing to the owner about a read that failed once and worked five minutes later", async () => {
    const db = justLive();

    await tick(db, 0, false);
    const sent = await tick(db, 5, true);

    expect(sent.res).toMatchObject({ sent: 3, incidents: { resolved: 1 } });
    expect(db.tables.rate_push_incidents).toEqual([
      expect.objectContaining({ cause: "awaiting_rate_read", customer_visible_at: null, alerted_at: null, resolution: "landed" }),
    ]);
    expect(alerts).toEqual([]);
  });

  it("counts the hour from when a night was first held, so a night that joins later does not reset it", async () => {
    const db = justLive();
    await tick(db, 0, false);
    // A day's new night enters the window half an hour in, with the hotel's own rate under it.
    db.tables.published_price.push({
      hotel_id: "hotel-1",
      stay_date: "2026-08-04",
      room_type_id: "rt-king",
      price: 215,
      computed_at: new Date(T0.getTime() + 30 * 60_000).toISOString(),
    });
    db.tables.base_rate_calendar.push({ hotel_id: "hotel-1", stay_date: "2026-08-04", room_type_id: "rt-king", price: 100 });
    await tick(db, 30, false);
    expect(db.tables.rate_push_incident_cells).toHaveLength(4);
    expect(db.tables.rate_push_incidents[0].customer_visible_at).toBeNull();

    await tick(db, 60, false);

    expect(db.tables.rate_push_incidents[0].customer_visible_at).not.toBeNull();
  });

  it("keeps sending the nights it has sent to before, and files only the ones it holds", async () => {
    const db = justLive();
    db.tables.rate_updates.push({
      hotel_id: "hotel-1",
      pms_type: "cloudbeds",
      stay_date: "2026-08-01",
      room_type_id: "rt-king",
      external_room_type_id: "CB-KING",
      external_rate_id: "rate-100",
      price: 200,
      status: "sent",
      attempts: 1,
      pushed_at: new Date(T0.getTime() - 3_600_000).toISOString(),
    });

    const res = await tick(db, 0, false);

    expect(res.attempts).toHaveLength(1);
    expect(res.res).toMatchObject({ sent: 1, awaitingBaseRead: 2 });
    expect(db.tables.rate_push_incident_cells.map((c) => c.stay_date)).toEqual(["2026-08-02", "2026-08-03"]);
  });
});

describe("pushRatesForHotel when the catalog has nothing to send to", () => {
  afterEach(() => {
    resetDecidedJobs();
    vi.restoreAllMocks();
  });

  function hotel(ledger: Row[] = [], targets: RateTargetMap | null = null) {
    return fakeSupabase({
      hotel_settings: [{ hotel_id: "hotel-1", simulation_mode: false }],
      room_types: [
        { id: "rt-king", hotel_id: "hotel-1", external_room_type_id: "CB-KING", ...OPEN_BOUNDS },
        { id: "rt-queen", hotel_id: "hotel-1", external_room_type_id: "CB-QUEEN", ...OPEN_BOUNDS },
      ],
      published_price: [
        { hotel_id: "hotel-1", stay_date: "2026-08-01", room_type_id: "rt-king", price: 210, computed_at: JUST_NOW },
        { hotel_id: "hotel-1", stay_date: "2026-08-01", room_type_id: "rt-queen", price: 180, computed_at: JUST_NOW },
      ],
      pms_connections: [{ id: "conn-1", hotel_id: "hotel-1", pms_type: "cloudbeds", push_rate_targets: targets }],
      rate_updates: ledger,
    });
  }

  it("files every room type when the catalog lists them but none has a base rate, and still settles earlier jobs", async () => {
    // Two STANDARD rate types tie for broadest and neither is named Best
    // Available: no base at all. The hotel used to stop pushing in silence.
    const db = hotel([
      { hotel_id: "hotel-1", stay_date: "2026-08-02", room_type_id: "rt-king", external_room_type_id: "CB-KING", price: 199, status: "sent", attempts: 1, pms_job_reference: "job-old", pushed_at: new Date(Date.now() - 10 * 60_000).toISOString() },
    ]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { adapter, attempts } = makeAdapter({});
    adapter.missingTargetReason = () => "no_base_rate";
    adapter.fetchJobOutcomes = async () => ({ "job-old": { done: true, ok: false, message: "rate closed" } });

    const res = await pushRatesForHotel(db.client, "hotel-1", adapter, WIDE);

    expect(attempts).toHaveLength(0);
    expect(res).toMatchObject({ pushed: true, sent: 0, skippedNoTarget: 2, jobsRejected: 1, incidents: { opened: 2, escalated: 1 } });
    expect(db.tables.rate_updates.filter((r) => r.status === "skipped").map((r) => [r.room_type_id, r.error, r.attempts])).toEqual([
      ["rt-king", "no rate target for room type", 0],
      ["rt-queen", "no rate target for room type", 0],
    ]);
    expect(db.tables.rate_push_incidents.find((i) => i.cause === "no_base_rate")).toMatchObject({ admin_only: false, resolved_at: null });
    expect(db.tables.rate_push_incidents.find((i) => i.cause === "no_base_rate")?.customer_visible_at).not.toBeNull();
  });

  it("stops quietly when the catalog read taught nothing", async () => {
    const db = hotel();
    const { adapter } = makeAdapter({});
    adapter.missingTargetReason = () => null;

    expect(await pushRatesForHotel(db.client, "hotel-1", adapter, WIDE)).toEqual({ pushed: false, reason: "no_rate_targets" });
    expect(db.tables.rate_updates).toEqual([]);
  });

  it("files a room type as a catalog it could not read, not a missing base rate, when the re-read fails", async () => {
    const db = hotel([], { "CB-QUEEN": "rate-200" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { adapter, attempts } = makeAdapter(new Error("Think /v1/hotels/9/rate_types failed (503): unavailable"));
    adapter.missingTargetReason = () => null;

    const res = await pushRatesForHotel(db.client, "hotel-1", adapter, WIDE);

    expect(attempts.map((a) => a.externalRoomTypeId)).toEqual(["CB-QUEEN"]);
    expect(res).toMatchObject({ sent: 1, skippedNoTarget: 1 });
    expect(db.tables.rate_push_incidents).toEqual([
      expect.objectContaining({ cause: "pms_unavailable", severity: "transient", customer_visible_at: null }),
    ]);
  });
});

describe("pushRatesForHotel when the catalog read fails between good ones", () => {
  afterEach(() => {
    resetDecidedJobs();
    vi.restoreAllMocks();
  });

  function hotel() {
    return fakeSupabase({
      hotel_settings: [{ hotel_id: "hotel-1", simulation_mode: false }],
      room_types: ROOM_TYPES.map((r) => ({ ...r, hotel_id: "hotel-1" })),
      published_price: PRICES_TWO.map((r) => ({ ...r, hotel_id: "hotel-1" })),
      pms_connections: [{ id: "conn-1", hotel_id: "hotel-1", pms_type: "cloudbeds", push_rate_targets: null }],
    });
  }
  /** Queen has a base rate; king has none, as a good read says, or nothing is known after a failed one. */
  const goodRead = () => {
    const made = makeAdapter({ "CB-QUEEN": "rate-200" });
    made.adapter.missingTargetReason = (ext) => (ext === "CB-KING" ? "no_base_rate" : null);
    return made.adapter;
  };
  const failedRead = () => {
    const made = makeAdapter(new Error("Cloudbeds getRatePlans failed (503): Service Unavailable"));
    made.adapter.missingTargetReason = () => null;
    return made.adapter;
  };
  const kingCells = (db: ReturnType<typeof hotel>) =>
    db.tables.rate_push_incident_cells.filter((c) => c.room_type_id === "rt-king").map((c) => [c.incident_id, c.state]);

  it("keeps a missing base rate open through a tick whose read fails (ok, throw, ok)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = hotel();

    await pushRatesForHotel(db.client, "hotel-1", goodRead(), WIDE);
    expect(db.tables.rate_push_incidents).toEqual([expect.objectContaining({ cause: "no_base_rate", resolved_at: null })]);
    const incidentId = db.tables.rate_push_incidents[0].id;

    const unreadable = await pushRatesForHotel(db.client, "hotel-1", failedRead(), WIDE);
    expect(unreadable).toMatchObject({ skippedNoTarget: 1 });
    expect(db.tables.rate_push_incidents).toEqual([expect.objectContaining({ cause: "no_base_rate", resolved_at: null })]);

    await pushRatesForHotel(db.client, "hotel-1", goodRead(), WIDE);
    expect(db.tables.rate_push_incidents).toEqual([
      expect.objectContaining({ cause: "no_base_rate", resolved_at: null, attempt_count: 1, customer_visible_at: expect.any(String) }),
    ]);
    expect(kingCells(db)).toEqual([[incidentId, "open"]]);
  });

  it("files a room type first seen on a failed read as a missing base rate once a good read says so (throw, ok)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = hotel();
    db.tables.pms_connections[0].push_rate_targets = { "CB-QUEEN": "rate-200" };

    await pushRatesForHotel(db.client, "hotel-1", failedRead(), WIDE);
    expect(db.tables.rate_push_incidents).toEqual([expect.objectContaining({ cause: "pms_unavailable", resolved_at: null })]);

    await pushRatesForHotel(db.client, "hotel-1", goodRead(), WIDE);
    expect(db.tables.rate_push_incidents.map((i) => [i.cause, i.resolution])).toEqual([
      ["pms_unavailable", "superseded"],
      ["no_base_rate", null],
    ]);
    expect(db.tables.rate_push_incidents[1].customer_visible_at).not.toBeNull();
  });
});

describe("pushRatesForHotel checks where an unchanged night went", () => {
  afterEach(() => {
    resetDecidedJobs();
    vi.restoreAllMocks();
  });

  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

  function sentHotel(targets: RateTargetMap | null, sentTo = "rate-package") {
    return fakeSupabase({
      hotel_settings: [{ hotel_id: "hotel-1", simulation_mode: false }],
      room_types: [{ id: "rt-king", hotel_id: "hotel-1", external_room_type_id: "CB-KING", ...OPEN_BOUNDS }],
      published_price: [{ hotel_id: "hotel-1", stay_date: "2026-08-01", room_type_id: "rt-king", price: 210, computed_at: minutesAgo(600) }],
      // Sent at this price before targets were base rates only, to a package.
      rate_updates: [
        { hotel_id: "hotel-1", stay_date: "2026-08-01", room_type_id: "rt-king", external_room_type_id: "CB-KING", price: 210, status: "sent", attempts: 1, external_rate_id: sentTo, pms_job_reference: "job-then", pushed_at: minutesAgo(600) },
      ],
      pms_connections: [{ id: "conn-1", hotel_id: "hotel-1", pms_type: "cloudbeds", push_rate_targets: targets }],
    });
  }

  it("sends a night again, at the same price, when its room type now maps to another rate", async () => {
    // The migration cleared the cached map; the price has not moved since.
    const db = sentHotel(null);
    const { adapter, attempts, calls } = makeAdapter({ "CB-KING": "rate-100" });

    const res = await pushRatesForHotel(db.client, "hotel-1", adapter, { ...WIDE, evaluatedAt: new Date().toISOString() });

    expect(calls.resolve).toBe(1);
    expect(attempts).toEqual([{ externalRoomTypeId: "CB-KING", externalRateId: "rate-100" }]);
    expect(res).toMatchObject({ sent: 1, skippedUnchanged: 0 });
    expect(db.tables.rate_updates).toEqual([expect.objectContaining({ status: "sent", price: 210, external_rate_id: "rate-100" })]);
  });

  it("files a sent night whose room type has no base rate now, and keeps it counted as sent to", async () => {
    const db = sentHotel(null);
    const { adapter, attempts } = makeAdapter({ "CB-QUEEN": "rate-200" });
    adapter.missingTargetReason = () => "no_base_rate";

    const res = await pushRatesForHotel(db.client, "hotel-1", adapter, { ...WIDE, evaluatedAt: new Date().toISOString() });

    expect(attempts).toHaveLength(0);
    expect(res).toMatchObject({ sent: 0, skippedNoTarget: 1, skippedUnchanged: 0, incidents: { opened: 1 } });
    // Attempts 1, and the send's reference and rate stay: MAYA's price is still on that rate.
    expect(db.tables.rate_updates).toEqual([
      expect.objectContaining({ status: "skipped", error: "no rate target for room type", attempts: 1, pms_job_reference: "job-then", external_rate_id: "rate-package" }),
    ]);
    expect(db.tables.rate_push_incidents[0]).toMatchObject({ cause: "no_base_rate" });
  });

  it("reads nothing more when the night went to the rate the cached map still names", async () => {
    const db = sentHotel({ "CB-KING": "rate-100" }, "rate-100");
    const { adapter, attempts, calls } = makeAdapter({ "CB-KING": "rate-100" });

    const res = await pushRatesForHotel(db.client, "hotel-1", adapter, WIDE);

    expect(calls.resolve).toBe(0);
    expect(attempts).toHaveLength(0);
    expect(res).toMatchObject({ sent: 0, skippedUnchanged: 1 });
  });

  it("holds and files a sent night the PMS now has at 0 with no typed price, so admins see MAYA's rate is still there", async () => {
    const db = sentHotel({ "CB-KING": "rate-100" }, "rate-100");
    db.tables.published_price[0].price = 1;
    db.tables.published_price[0].computed_at = new Date().toISOString();
    db.tables.rate_updates[0].price = 1;
    db.tables.base_rate_calendar = [
      { hotel_id: "hotel-1", stay_date: "2026-08-01", room_type_id: "rt-king", price: 0 },
      ...calendarUnder(db.tables.published_price, (r) => r.stay_date === "2026-08-01" && r.room_type_id === "rt-king"),
    ];
    const { adapter, attempts } = makeAdapter({ "CB-KING": "rate-100" });

    const res = await pushRatesForHotel(db.client, "hotel-1", adapter, WIDE);

    expect(attempts).toHaveLength(0);
    expect(res).toMatchObject({ skippedUnchanged: 0, skippedGuardrail: 1, guardrails: { "guardrail:zero_base": 1 } });
    expect(db.tables.rate_updates).toEqual([
      expect.objectContaining({ status: "skipped", error: "guardrail:zero_base", price: 1, attempts: 1, external_rate_id: "rate-100" }),
    ]);
    expect(db.tables.rate_push_incidents).toEqual([expect.objectContaining({ cause: "guardrail_zero_base", admin_only: true })]);

    // Next tick: nothing rewritten, still held, still open.
    const again = await pushRatesForHotel(db.client, "hotel-1", makeAdapter({ "CB-KING": "rate-100" }).adapter, WIDE);
    expect(again).toMatchObject({ skippedGuardrail: 1 });
    expect(db.tables.rate_push_incidents[0].resolved_at).toBeNull();
  });
});

describe("pushRatesForHotel and what the tick knows", () => {
  afterEach(() => vi.restoreAllMocks());
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

  it("holds back only never-sent nights when this tick's base read did not happen", async () => {
    const db = makeSupabaseStub({
      publishedPrice: PRICES_TWO,
      roomTypes: ROOM_TYPES,
      // Queen was sent before at another price: its base is frozen anyway.
      ledger: [{ stay_date: "2026-08-01", room_type_id: "rt-queen", price: 170, status: "sent", attempts: 1 }],
      connection: { id: "conn-1", push_rate_targets: CACHED_TWO },
    });
    const { adapter, attempts } = makeAdapter(CACHED_TWO);

    const res = await pushRatesForHotel(db.supabase, "hotel-1", adapter, { ...WIDE, holdNeverPushed: true });

    expect(attempts.map((a) => a.externalRoomTypeId)).toEqual(["CB-QUEEN"]);
    expect(res).toMatchObject({ sent: 1, awaitingBaseRead: 1 });
    expect(finalLedger(db).map((r) => r.room_type_id)).toEqual(["rt-queen"]);
  });

  it("reads the PMS again before a new price goes to a night it sent to, and holds the nights whose rate there moved", async () => {
    const PRICES = [
      ...PRICES_TWO,
      { stay_date: "2026-08-02", room_type_id: "rt-king", price: 220, computed_at: JUST_NOW },
    ];
    const db = makeSupabaseStub({
      publishedPrice: PRICES,
      roomTypes: ROOM_TYPES,
      ledger: [
        { stay_date: "2026-08-01", room_type_id: "rt-king", price: 200, status: "sent", attempts: 1, pushed_at: minutesAgo(90) },
        { stay_date: "2026-08-02", room_type_id: "rt-king", price: 200, status: "sent", attempts: 1, pushed_at: minutesAgo(90) },
      ],
      connection: { id: "conn-1", push_rate_targets: CACHED_TWO },
    });
    const { adapter, attempts } = makeAdapter(CACHED_TWO);
    let reads = 0;
    const readBeforeResend = {
      settleMs: 60 * 60_000,
      read: async () => {
        reads += 1;
        // The hotel changed the King on the 1st since the hourly read.
        return new Set(["2026-08-01|rt-king"]);
      },
    };

    const res = await pushRatesForHotel(db.supabase, "hotel-1", adapter, { ...WIDE, readBeforeResend });

    expect(reads).toBe(1);
    expect(attempts.map((a) => a.externalRoomTypeId).sort()).toEqual(["CB-KING", "CB-QUEEN"]);
    expect(finalLedger(db).map((r) => `${r.stay_date}|${r.room_type_id}|${r.price}`).sort()).toEqual([
      "2026-08-01|rt-queen|180",
      "2026-08-02|rt-king|220",
    ]);
    expect(res).toMatchObject({ sent: 2, changedInPms: 1 });
  });

  it("sends as before when the read before re-sending could not be made, and reads nothing for nights it never sent to", async () => {
    const sentBefore = [{ stay_date: "2026-08-01", room_type_id: "rt-king", price: 200, status: "sent", attempts: 1, pushed_at: minutesAgo(90) }];
    const db = makeSupabaseStub({ publishedPrice: PRICES_TWO, roomTypes: ROOM_TYPES, ledger: sentBefore, connection: { id: "conn-1", push_rate_targets: CACHED_TWO } });
    const { adapter, attempts } = makeAdapter(CACHED_TWO);
    const res = await pushRatesForHotel(db.supabase, "hotel-1", adapter, { ...WIDE, readBeforeResend: { settleMs: 60 * 60_000, read: async () => null } });
    expect(attempts).toHaveLength(2);
    expect(res).not.toHaveProperty("changedInPms");

    const fresh = makeSupabaseStub({ publishedPrice: PRICES_TWO, roomTypes: ROOM_TYPES, connection: { id: "conn-1", push_rate_targets: CACHED_TWO } });
    let reads = 0;
    const none = await pushRatesForHotel(fresh.supabase, "hotel-1", makeAdapter(CACHED_TWO).adapter, {
      ...WIDE,
      readBeforeResend: {
        settleMs: 60 * 60_000,
        read: async () => {
          reads += 1;
          return new Set<string>();
        },
      },
    });
    expect(reads).toBe(0);
    expect(none).not.toHaveProperty("readBeforeResendMs");
  });

  it("reads before re-sending only when a night about to get a new price was sent to over the settle window ago, and says how long it took", async () => {
    let reads = 0;
    const readBeforeResend = {
      settleMs: 60 * 60_000,
      read: async () => {
        reads += 1;
        return new Set<string>();
      },
    };
    const sent = (over: Row) => [{ stay_date: "2026-08-01", room_type_id: "rt-king", price: 200, status: "sent", attempts: 1, ...over }];
    const push = (ledger: Row[]) =>
      pushRatesForHotel(
        makeSupabaseStub({ publishedPrice: PRICES_TWO, roomTypes: ROOM_TYPES, ledger, connection: { id: "conn-1", push_rate_targets: CACHED_TWO } }).supabase,
        "hotel-1",
        makeAdapter(CACHED_TWO).adapter,
        { ...WIDE, readBeforeResend },
      );

    // Sent twenty minutes ago, or with no time on record: no read could take a change there, so none is made.
    for (const ledger of [sent({ pushed_at: minutesAgo(20) }), sent({ pushed_at: null })]) {
      const res = await push(ledger);
      expect(res).toMatchObject({ sent: 2 });
      expect(res).not.toHaveProperty("readBeforeResendMs");
    }
    expect(reads).toBe(0);

    const old = await push(sent({ pushed_at: minutesAgo(61) }));
    expect(reads).toBe(1);
    expect(old).toMatchObject({ sent: 2, readBeforeResendMs: expect.any(Number) });
  });

  it("sends a cell held for a missing permission again once the connection was re-authorized after the refusal", async () => {
    const scope = "Cloudbeds patchRate failed (403): scope required for this call was not granted by property";
    const ledger = [
      { stay_date: "2026-08-01", room_type_id: "rt-king", price: 210, status: "failed", attempts: 1, error: scope, external_rate_id: "rate-100", pushed_at: minutesAgo(10) },
    ];
    const held = makeSupabaseStub({ publishedPrice: [PRICES_TWO[0]], roomTypes: ROOM_TYPES, ledger, connection: { id: "conn-1", push_rate_targets: CACHED_TWO } });
    expect(await pushRatesForHotel(held.supabase, "hotel-1", makeAdapter(CACHED_TWO).adapter, WIDE)).toMatchObject({ sent: 0, skippedHeld: 1 });

    const reconnected = makeSupabaseStub({
      publishedPrice: [PRICES_TWO[0]],
      roomTypes: ROOM_TYPES,
      ledger,
      connection: { id: "conn-1", push_rate_targets: CACHED_TWO, reauthorized_at: minutesAgo(5) },
    });
    const { adapter, attempts } = makeAdapter(CACHED_TWO);
    const res = await pushRatesForHotel(reconnected.supabase, "hotel-1", adapter, WIDE);
    expect(attempts).toHaveLength(1);
    expect(res).toMatchObject({ sent: 1 });
    expect(res).not.toHaveProperty("skippedHeld");
  });

  it("lets a logged evaluation vouch only for the nights it priced", async () => {
    const old = minutesAgo(180);
    const db = makeSupabaseStub({
      publishedPrice: [
        { stay_date: "2026-08-01", room_type_id: "rt-king", price: 210, computed_at: old },
        { stay_date: "2026-08-05", room_type_id: "rt-king", price: 230, computed_at: old },
      ],
      roomTypes: ROOM_TYPES,
      connection: { id: "conn-1", push_rate_targets: CACHED_TWO },
      // A manual price save for tonight evaluated tonight only; the scheduled ones failed.
      evaluations: [
        { evaluated_at: minutesAgo(2), first_stay_date: "2026-08-01", last_stay_date: "2026-08-01" },
        // From before the nights were logged: vouches for nothing.
        { evaluated_at: minutesAgo(3), first_stay_date: null, last_stay_date: null },
      ],
    });
    const { adapter, attempts } = makeAdapter(CACHED_TWO);

    const res = await pushRatesForHotel(db.supabase, "hotel-1", adapter, WIDE);

    expect(attempts).toHaveLength(1);
    expect(res).toMatchObject({ sent: 1, guardrails: { "guardrail:stale_price": 1 } });
    expect(finalLedger(db).find((r) => r.stay_date === "2026-08-05")).toMatchObject({ status: "skipped", error: "guardrail:stale_price" });
  });

  describe("a write refused over the grant", () => {
    function connected(pmsType = "cloudbeds") {
      return fakeSupabase({
        hotel_settings: [{ hotel_id: "hotel-1", simulation_mode: false }],
        room_types: [{ id: "rt-king", hotel_id: "hotel-1", external_room_type_id: "CB-KING", ...OPEN_BOUNDS }],
        published_price: [{ hotel_id: "hotel-1", stay_date: "2026-08-01", room_type_id: "rt-king", price: 210, computed_at: JUST_NOW }],
        pms_connections: [{ id: "conn-1", hotel_id: "hotel-1", pms_type: pmsType, status: "connected", push_rate_targets: { "CB-KING": "rate-100" } }],
      });
    }
    const refusing = (result: Partial<CellPushResult>, pmsType: PmsRatePushAdapter["pmsType"] = "cloudbeds") => {
      const { adapter } = makeAdapter({ "CB-KING": "rate-100" });
      adapter.pmsType = pmsType;
      adapter.pushCells = async (cells) => cells.map((cell) => ({ cell, ok: false, ...result }));
      return adapter;
    };

    it("leaves the connection up on a bare 401 after the read worked, and holds the night for the owner to see", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});
      const db = connected();

      const res = await pushRatesForHotel(db.client, "hotel-1", refusing({ error: "Cloudbeds patchRate failed (401): Unauthorized", httpStatus: 401 }), WIDE);

      expect(res).toMatchObject({ failed: 1 });
      expect(db.tables.pms_connections[0].status).toBe("connected");
      expect(db.calls.some((c) => c.table === "rpc:platform_log_event")).toBe(false);
      expect(db.tables.rate_push_incidents).toEqual([
        expect.objectContaining({ cause: "missing_write_permission", severity: "critical", customer_visible_at: expect.any(String) }),
      ]);
      // Held until a reconnect, not sent again next tick.
      const next = await pushRatesForHotel(db.client, "hotel-1", makeAdapter({ "CB-KING": "rate-100" }).adapter, WIDE);
      expect(next).toMatchObject({ sent: 0, skippedHeld: 1 });
    });

    it("takes the grant as gone when credentials minted after the 401 are refused too", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});
      const db = connected();

      await pushRatesForHotel(
        db.client,
        "hotel-1",
        refusing({ error: "Cloudbeds patchRate failed (401): Unauthorized", httpStatus: 401, freshCredentialsRefused: true }),
        WIDE,
      );

      expect(db.tables.pms_connections[0].status).toBe("disconnected");
      expect(db.tables.rate_push_incidents).toEqual([expect.objectContaining({ cause: "auth_revoked" })]);
    });

    it("never takes a Think connection offline from a push", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});
      for (const result of [
        { error: "Think /v1/hotels/1/rate_types/2/daily failed (401): invalid_grant", httpStatus: 401, freshCredentialsRefused: true },
        { error: "Think /v1/hotels/1/rate_types/2/daily failed (400): App is not connected", httpStatus: 400 },
      ]) {
        const db = connected("think");
        await pushRatesForHotel(db.client, "hotel-1", refusing(result, "think"), WIDE);
        expect(db.tables.pms_connections[0].status).toBe("connected");
        expect(db.tables.rate_push_incidents).toEqual([expect.objectContaining({ cause: "missing_write_permission" })]);
      }
    });
  });

  it("marks the connection disconnected when the write says the grant is gone", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const db = fakeSupabase({
      hotel_settings: [{ hotel_id: "hotel-1", simulation_mode: false }],
      room_types: [{ id: "rt-king", hotel_id: "hotel-1", external_room_type_id: "CB-KING", ...OPEN_BOUNDS }],
      published_price: [{ hotel_id: "hotel-1", stay_date: "2026-08-01", room_type_id: "rt-king", price: 210, computed_at: JUST_NOW }],
      pms_connections: [{ id: "conn-1", hotel_id: "hotel-1", pms_type: "cloudbeds", status: "connected", push_rate_targets: { "CB-KING": "rate-100" } }],
    });
    const { adapter } = makeAdapter({ "CB-KING": "rate-100" });
    adapter.pushCells = async (cells) =>
      cells.map((cell) => ({ cell, ok: false, error: "Cloudbeds patchRate failed (400): Application is not available to be connected", httpStatus: 400 }));

    const res = await pushRatesForHotel(db.client, "hotel-1", adapter, WIDE);

    expect(res).toMatchObject({ failed: 1 });
    expect(db.tables.pms_connections[0].status).toBe("disconnected");
    expect(db.calls.some((c) => c.table === "rpc:platform_log_event")).toBe(true);
    errors.mockRestore();
  });
});

describe("pushRatesForHotel and manual prices", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetDecidedJobs();
  });
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const KING_FLOORED = [{ id: "rt-king", hotel_id: "hotel-1", external_room_type_id: "CB-KING", is_active: true, floor_price: 89, ceiling_price: 500 }];

  function manualDb(published: Row[], manual: Row[], more: Record<string, Row[]> = {}) {
    return fakeSupabase({
      hotel_settings: [{ hotel_id: "hotel-1", simulation_mode: false }],
      room_types: KING_FLOORED,
      published_price: published.map((r) => ({ hotel_id: "hotel-1", room_type_id: "rt-king", computed_at: JUST_NOW, ...r })),
      manual_price: manual.map((r) => ({ hotel_id: "hotel-1", room_type_id: "rt-king", cleared_at: null, set_at: minutesAgo(60), ...r })),
      pms_connections: [{ id: "conn-1", hotel_id: "hotel-1", pms_type: "cloudbeds", push_rate_targets: { "CB-KING": "rate-100" } }],
      ...more,
    });
  }

  it("sends a manual price under the floor or over the ceiling as published, and holds a comp night's 0 for a PMS not known to take it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const db = manualDb(
      [
        { stay_date: "2026-08-01", price: 50 },
        { stay_date: "2026-08-02", price: 750 },
        { stay_date: "2026-08-03", price: 0 },
        // Not a manual night: the floor still holds.
        { stay_date: "2026-08-04", price: 50 },
      ],
      [
        { stay_date: "2026-08-01", price: 50 },
        { stay_date: "2026-08-02", price: 750 },
        { stay_date: "2026-08-03", price: 0 },
      ],
    );
    const { adapter, attempts } = makeAdapter({ "CB-KING": "rate-100" });
    const sentPrices: number[] = [];
    const push = adapter.pushCells;
    adapter.pushCells = async (cells) => (sentPrices.push(...cells.map((c) => c.price)), push(cells));

    const res = await pushRatesForHotel(db.client, "hotel-1", adapter, WIDE);

    expect(sentPrices).toEqual([50, 750]);
    expect(attempts).toHaveLength(2);
    expect(res).toMatchObject({
      sent: 2,
      skippedGuardrail: 2,
      guardrails: { "guardrail:zero_rate_unsupported": 1, "guardrail:below_floor": 1 },
    });
    const row = (d: string) => db.tables.rate_updates.find((r) => r.stay_date === d);
    expect(row("2026-08-03")).toMatchObject({ status: "skipped", error: "guardrail:zero_rate_unsupported", price: 0, attempts: 0 });
    // The owner hears about the comp night; the floor hold stays with admins.
    expect(db.tables.rate_push_incidents.map((i) => [i.cause, i.admin_only, i.customer_visible_at != null]).sort()).toEqual([
      ["guardrail_below_floor", true, false],
      ["zero_rate_unsupported", false, true],
    ]);
  });

  it("counts a comp night the PMS already has at 0 as nothing to send once MAYA never sent to it, and closes what it filed", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const db = manualDb([{ stay_date: "2026-08-03", price: 0 }], [{ stay_date: "2026-08-03", price: 0 }]);
    const first = await pushRatesForHotel(db.client, "hotel-1", makeAdapter({ "CB-KING": "rate-100" }).adapter, WIDE);
    expect(first).toMatchObject({ sent: 0, skippedGuardrail: 1, guardrails: { "guardrail:zero_rate_unsupported": 1 } });
    expect(db.tables.rate_push_incidents).toEqual([expect.objectContaining({ cause: "zero_rate_unsupported", resolved_at: null })]);

    // The owner sets the night to 0 in Cloudbeds, and the base rate read stores that.
    db.tables.base_rate_calendar = [
      { hotel_id: "hotel-1", stay_date: "2026-08-03", room_type_id: "rt-king", price: 0 },
      ...calendarUnder(db.tables.published_price, (r) => r.stay_date === "2026-08-03" && r.room_type_id === "rt-king"),
    ];
    const second = await pushRatesForHotel(db.client, "hotel-1", makeAdapter({ "CB-KING": "rate-100" }).adapter, WIDE);

    expect(second).toMatchObject({ sent: 0, skippedGuardrail: 0, compInPms: 1 });
    expect(second).not.toHaveProperty("guardrails");
    expect(db.tables.rate_push_incidents[0]).toMatchObject({ resolution: "landed" });
    // Nothing was ever sent there, and the ledger still says so.
    expect(db.tables.rate_updates).toEqual([
      expect.objectContaining({ stay_date: "2026-08-03", status: "skipped", error: "guardrail:zero_rate_unsupported", attempts: 0 }),
    ]);
  });

  it("keeps filing a comp night the PMS has at 0 under a send of MAYA's, whose stored base says nothing about now", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const db = manualDb([{ stay_date: "2026-08-03", price: 0 }], [{ stay_date: "2026-08-03", price: 0 }], {
      base_rate_calendar: [{ hotel_id: "hotel-1", stay_date: "2026-08-03", room_type_id: "rt-king", price: 0 }],
      rate_updates: [
        { hotel_id: "hotel-1", pms_type: "cloudbeds", stay_date: "2026-08-03", room_type_id: "rt-king", external_room_type_id: "CB-KING", price: 180, status: "sent", attempts: 1 },
      ],
    });

    const res = await pushRatesForHotel(db.client, "hotel-1", makeAdapter({ "CB-KING": "rate-100" }).adapter, WIDE);

    expect(res).toMatchObject({ skippedGuardrail: 1, guardrails: { "guardrail:zero_rate_unsupported": 1 } });
    expect(res).not.toHaveProperty("compInPms");
  });

  it("sends a comp night's 0 to a PMS that takes it", async () => {
    const db = manualDb([{ stay_date: "2026-08-01", price: 0 }], [{ stay_date: "2026-08-01", price: 0 }]);
    const { adapter } = makeAdapter({ "CB-KING": "rate-100" });
    adapter.acceptsZeroRate = true;
    let sent: number[] = [];
    adapter.pushCells = async (cells) => ((sent = cells.map((c) => c.price)), cells.map((cell) => ({ cell, ok: true, jobReference: "job-1" })));

    const res = await pushRatesForHotel(db.client, "hotel-1", adapter, WIDE);

    expect(sent).toEqual([0]);
    expect(res).toMatchObject({ sent: 1, skippedGuardrail: 0 });
    expect(db.tables.rate_updates[0]).toMatchObject({ status: "sent", price: 0, sent_price: 0 });
  });

  it("holds a price priced before the manual price on its night until an evaluation prices it again", async () => {
    const setAt = minutesAgo(2);
    const published = [{ stay_date: "2026-08-01", price: 230, computed_at: minutesAgo(10) }];
    const manual = [{ stay_date: "2026-08-01", price: 200, set_at: setAt }];

    // The evaluation after the manual price failed: MAYA's old 230 must not go out over it.
    const stale = manualDb(published, manual);
    const first = makeAdapter({ "CB-KING": "rate-100" });
    const held = await pushRatesForHotel(stale.client, "hotel-1", first.adapter, WIDE);
    expect(first.attempts).toHaveLength(0);
    expect(held).toMatchObject({ sent: 0, awaitingEvaluation: 1 });
    expect(stale.tables.rate_updates ?? []).toEqual([]);

    // A logged run that priced the night after the manual price vouches for it.
    const logged = manualDb(published, manual, {
      evaluation_run_log: [{ hotel_id: "hotel-1", evaluated_at: minutesAgo(1), first_stay_date: "2026-08-01", last_stay_date: "2026-08-01" }],
    });
    const second = makeAdapter({ "CB-KING": "rate-100" });
    expect(await pushRatesForHotel(logged.client, "hotel-1", second.adapter, WIDE)).toMatchObject({ sent: 1 });

    // So does this tick's own evaluation.
    const ticked = manualDb(published, manual);
    const third = makeAdapter({ "CB-KING": "rate-100" });
    const res = await pushRatesForHotel(ticked.client, "hotel-1", third.adapter, { ...WIDE, evaluatedAt: new Date().toISOString() });
    expect(res).toMatchObject({ sent: 1 });
    expect(res).not.toHaveProperty("awaitingEvaluation");
  });

  it("stamps a confirmed job's sent rows as settled, and a new send starts unsettled", async () => {
    const db = fakeSupabase({
      hotel_settings: [{ hotel_id: "hotel-1", simulation_mode: false }],
      room_types: ROOM_TYPES.map((r) => ({ ...r, hotel_id: "hotel-1" })),
      published_price: PRICES_TWO.map((r) => ({ ...r, hotel_id: "hotel-1" })),
      pms_connections: [{ id: "conn-1", hotel_id: "hotel-1", pms_type: "cloudbeds", push_rate_targets: CACHED_TWO }],
      rate_updates: [
        // Queen went out earlier at another price, was confirmed, and was changed in the PMS since.
        { hotel_id: "hotel-1", pms_type: "cloudbeds", stay_date: "2026-08-01", room_type_id: "rt-queen", external_room_type_id: "CB-QUEEN", price: 170, sent_price: 170, status: "sent", attempts: 1, pms_job_reference: "job-then", confirmed_at: minutesAgo(80), pms_edited_at: minutesAgo(20), pushed_at: minutesAgo(90) },
      ],
    });
    const { adapter } = makeAdapter(CACHED_TWO, "CB-QUEEN");
    adapter.pushCells = async (cells) =>
      cells.map((cell) => ({ cell, ok: true, jobReference: cell.externalRoomTypeId === "CB-KING" ? "job-king" : "job-queen" }));
    adapter.fetchJobOutcomes = async (refs) =>
      Object.fromEntries(refs.map((r) => [r, r === "job-king" ? { done: true, ok: true } : { done: true, ok: false, message: "rate closed" }]));

    const res = await pushRatesForHotel(db.client, "hotel-1", adapter, WIDE);

    expect(res).toMatchObject({ sent: 2, jobsConfirmed: 1, jobsRejected: 1 });
    const row = (room: string) => db.tables.rate_updates.find((r) => r.room_type_id === room)!;
    expect(row("rt-king")).toMatchObject({ status: "sent", pms_job_reference: "job-king", pms_edited_at: null });
    expect(typeof row("rt-king").confirmed_at).toBe("string");
    expect(row("rt-queen")).toMatchObject({ status: "failed", pms_job_reference: "job-queen", confirmed_at: null, pms_edited_at: null });
  });

  it("asks about a confirmed job again when its rows could not be stamped", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let failStamp = true;
    const seed = () => ({
      hotel_settings: [{ hotel_id: "hotel-1", simulation_mode: false }],
      room_types: ROOM_TYPES.map((r) => ({ ...r, hotel_id: "hotel-1" })),
      published_price: [{ ...PRICES_TWO[0], hotel_id: "hotel-1" }],
      pms_connections: [{ id: "conn-1", hotel_id: "hotel-1", pms_type: "cloudbeds", push_rate_targets: CACHED_TWO }],
      rate_updates: [
        { hotel_id: "hotel-1", pms_type: "cloudbeds", stay_date: "2026-08-01", room_type_id: "rt-king", external_room_type_id: "CB-KING", price: 210, status: "sent", attempts: 1, pms_job_reference: "job-done", confirmed_at: null, pushed_at: minutesAgo(5) },
      ],
    });
    const asked: string[] = [];
    const { adapter } = makeAdapter(CACHED_TWO);
    adapter.fetchJobOutcomes = async (refs) => (asked.push(...refs), Object.fromEntries(refs.map((r) => [r, { done: true, ok: true }])));
    const fault = (c: { table: string; op: string }) =>
      failStamp && c.table === "rate_updates" && c.op === "update" ? { message: "canceling statement due to statement timeout" } : null;

    await pushRatesForHotel(fakeSupabase(seed(), { fault }).client, "hotel-1", adapter, WIDE);
    expect(errors.mock.calls.some((c) => String(c[0]).includes("rate_job_confirm_stamp_failed"))).toBe(true);

    failStamp = false;
    const db = fakeSupabase(seed(), { fault });
    await pushRatesForHotel(db.client, "hotel-1", adapter, WIDE);
    expect(asked).toEqual(["job-done", "job-done"]);
    expect(typeof db.tables.rate_updates[0].confirmed_at).toBe("string");

    // Stamped: decided, not asked again.
    await pushRatesForHotel(fakeSupabase(seed()).client, "hotel-1", adapter, WIDE);
    expect(asked).toHaveLength(2);
  });

  it("writes its ledger rows without the settle columns on a database that does not have them yet", async () => {
    const db = fakeSupabase(
      {
        hotel_settings: [{ hotel_id: "hotel-1", simulation_mode: false }],
        room_types: ROOM_TYPES.map((r) => ({ ...r, hotel_id: "hotel-1" })),
        published_price: PRICES_TWO.map((r) => ({ ...r, hotel_id: "hotel-1" })),
        pms_connections: [{ id: "conn-1", hotel_id: "hotel-1", pms_type: "cloudbeds", push_rate_targets: CACHED_TWO }],
      },
      {
        fault: (c) =>
          c.table === "rate_updates" && c.op === "upsert" && callTouchesColumn(c, "confirmed_at")
            ? missingColumn("rate_updates", "confirmed_at")
            : null,
      },
    );
    const { adapter } = makeAdapter(CACHED_TWO);

    const res = await pushRatesForHotel(db.client, "hotel-1", adapter, WIDE);

    expect(res).toMatchObject({ sent: 2 });
    expect(db.tables.rate_updates.every((r) => r.status === "sent" && !("confirmed_at" in r) && !("pms_edited_at" in r))).toBe(true);
  });
});

describe("pushRatesForHotel and Try again on a typed price", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetDecidedJobs();
  });
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const VALUE_REFUSED = "Cloudbeds patchRate failed (400): Rate must be greater than 500";
  const OUTAGE = "Cloudbeds patchRate failed (503): Service Unavailable";
  const KING = { stay_date: "2026-08-01", room_type_id: "rt-king", external_rate_id: "rate-100" };

  function liveHotel(ledger: Row[], fault?: Parameters<typeof fakeSupabase>[1]) {
    return fakeSupabase(
      {
        hotel_settings: [{ hotel_id: "hotel-1", simulation_mode: false }],
        room_types: [{ id: "rt-king", hotel_id: "hotel-1", external_room_type_id: "CB-KING", ...OPEN_BOUNDS }],
        published_price: [{ hotel_id: "hotel-1", stay_date: "2026-08-01", room_type_id: "rt-king", price: 210, computed_at: JUST_NOW }],
        pms_connections: [{ id: "conn-1", hotel_id: "hotel-1", pms_type: "cloudbeds", push_rate_targets: { "CB-KING": "rate-100" } }],
        rate_updates: ledger.map((r) => ({ hotel_id: "hotel-1", ...r })),
      },
      fault,
    );
  }
  const row = (db: ReturnType<typeof liveHotel>) => db.tables.rate_updates.find((r) => r.room_type_id === "rt-king")!;

  it("sends a held cell once more when Try again was pressed after its last try, and the try spends the press", async () => {
    const pressed = minutesAgo(1);
    const db = liveHotel([
      { ...KING, price: 210, status: "failed", attempts: 1, error: VALUE_REFUSED, pushed_at: minutesAgo(5), retry_requested_at: pressed },
    ]);
    const { adapter, attempts } = makeAdapter({ "CB-KING": "rate-100" });

    const res = await pushRatesForHotel(db.client, "hotel-1", adapter, WIDE);

    expect(res).toMatchObject({ sent: 1 });
    expect(attempts.map((a) => a.externalRoomTypeId)).toEqual(["CB-KING"]);
    // The press stays on the row untouched; the try's pushed_at is past it.
    expect(row(db)).toMatchObject({ status: "sent", attempts: 2, retry_requested_at: pressed });
    expect(Date.parse(String(row(db).pushed_at))).toBeGreaterThan(Date.parse(pressed));
    expect(db.calls.some((c) => c.table === "rate_updates" && c.op === "upsert" && callTouchesColumn(c, "retry_requested_at"))).toBe(false);
  });

  it("gives an exhausted cell exactly one more try per press", async () => {
    const db = liveHotel([
      { ...KING, price: 210, status: "failed", attempts: 10, error: OUTAGE, pushed_at: minutesAgo(5), retry_requested_at: minutesAgo(1) },
    ]);
    const refused = makeAdapter({ "CB-KING": "rate-100" });
    refused.adapter.pushCells = async (cells) => cells.map((cell) => ({ cell, ok: false, error: OUTAGE, httpStatus: 503 }));

    const first = await pushRatesForHotel(db.client, "hotel-1", refused.adapter, WIDE);
    expect(first).toMatchObject({ failed: 1, skippedExhausted: 0 });
    expect(row(db)).toMatchObject({ status: "failed", attempts: 11 });

    // The press is older than that try now, so the cell rests again.
    const second = await pushRatesForHotel(db.client, "hotel-1", makeAdapter({ "CB-KING": "rate-100" }).adapter, WIDE);
    expect(second).toMatchObject({ sent: 0, skippedExhausted: 1 });
  });

  it("leaves a press that came before the last try alone", async () => {
    const db = liveHotel([
      { ...KING, price: 210, status: "failed", attempts: 1, error: VALUE_REFUSED, pushed_at: minutesAgo(5), retry_requested_at: minutesAgo(30) },
    ]);
    const { adapter, attempts } = makeAdapter({ "CB-KING": "rate-100" });

    const res = await pushRatesForHotel(db.client, "hotel-1", adapter, WIDE);

    expect(res).toMatchObject({ sent: 0, skippedHeld: 1 });
    expect(attempts).toEqual([]);
  });

  it("reads the ledger without retry_requested_at on a database that does not have it yet", async () => {
    const db = liveHotel(
      [{ ...KING, price: 210, status: "failed", attempts: 1, error: VALUE_REFUSED, pushed_at: minutesAgo(5) }],
      {
        fault: (c) =>
          c.table === "rate_updates" && c.op === "select" && c.columns.includes("retry_requested_at")
            ? missingColumn("rate_updates", "retry_requested_at")
            : null,
      },
    );
    const { adapter, attempts } = makeAdapter({ "CB-KING": "rate-100" });

    const res = await pushRatesForHotel(db.client, "hotel-1", adapter, WIDE);

    // Still held: the row was read, just without the column.
    expect(res).toMatchObject({ sent: 0, skippedHeld: 1 });
    expect(attempts).toEqual([]);
    const reads = db.calls.filter((c) => c.table === "rate_updates" && c.op === "select");
    expect(reads.map((c) => c.columns.includes("retry_requested_at"))).toEqual([true, false]);
  });
});

describe("a job the vendor applied in part (audit A18)", () => {
  afterEach(() => {
    resetDecidedJobs();
    vi.restoreAllMocks();
  });
  const NIGHTS = ["2026-08-01", "2026-08-02", "2026-08-03"];

  function world() {
    return fakeSupabase({
      hotel_settings: [{ hotel_id: "hotel-1", simulation_mode: false }],
      room_types: ROOM_TYPES.map((r) => ({ ...r, hotel_id: "hotel-1" })),
      published_price: NIGHTS.map((d) => ({ hotel_id: "hotel-1", stay_date: d, room_type_id: "rt-king", price: 210, computed_at: JUST_NOW })),
      pms_connections: [{ id: "conn-1", hotel_id: "hotel-1", pms_type: "cloudbeds", push_rate_targets: CACHED_TWO }],
      rate_updates: [],
    });
  }

  function jobAdapter(outcome: Record<string, unknown>) {
    const { adapter } = makeAdapter(CACHED_TWO);
    adapter.pushCells = async (cells) => cells.map((cell) => ({ cell, ok: true, jobReference: "job-king" }));
    adapter.fetchJobOutcomes = async () => ({ "job-king": outcome as never });
    return adapter;
  }

  const row = (db: ReturnType<typeof world>, d: string) => db.tables.rate_updates.find((r) => r.stay_date === d)!;

  it("fails only the night it rejected, and confirms the rest", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = world();
    const adapter = jobAdapter({
      done: true,
      ok: false,
      message: "Rate is closed for this date",
      intervals: [
        { startDate: "2026-08-01", endDate: "2026-08-01", ok: true },
        { startDate: "2026-08-02", endDate: "2026-08-02", ok: false, message: "Rate is closed for this date" },
        { startDate: "2026-08-03", endDate: "2026-08-03", ok: true },
      ],
    });

    const res = await pushRatesForHotel(db.client, "hotel-1", adapter, WIDE);

    expect(res).toMatchObject({ sent: 3, jobsConfirmed: 2, jobsRejected: 1 });
    expect(row(db, "2026-08-02")).toMatchObject({ status: "failed", error: "Rate is closed for this date", pms_job_reference: "job-king", confirmed_at: null });
    for (const d of ["2026-08-01", "2026-08-03"]) {
      expect(row(db, d)).toMatchObject({ status: "sent", pms_job_reference: "job-king" });
      expect(typeof row(db, d).confirmed_at).toBe("string");
    }
  });

  it("takes a night the vendor said nothing about as not applied, with the job's reason", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = world();
    const adapter = jobAdapter({
      done: true,
      ok: false,
      message: "job error",
      intervals: [{ startDate: "2026-08-01", endDate: "2026-08-02", ok: true }],
    });
    const res = await pushRatesForHotel(db.client, "hotel-1", adapter, WIDE);
    expect(res).toMatchObject({ jobsConfirmed: 2, jobsRejected: 1 });
    expect(row(db, "2026-08-03")).toMatchObject({ status: "failed", error: "job error" });
    expect(typeof row(db, "2026-08-02").confirmed_at).toBe("string");
  });

  it("fails the whole job, as before, when the vendor names no nights", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = world();
    const res = await pushRatesForHotel(db.client, "hotel-1", jobAdapter({ done: true, ok: false, message: "job error" }), WIDE);
    expect(res).toMatchObject({ jobsConfirmed: 0, jobsRejected: 3 });
    expect(NIGHTS.map((d) => row(db, d).status)).toEqual(["failed", "failed", "failed"]);
  });

  it("confirms none of it while the rejected nights cannot be written as failed, and asks again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const asked: string[] = [];
    const outcome = {
      done: true,
      ok: false,
      message: "closed",
      intervals: [
        { startDate: "2026-08-01", endDate: "2026-08-01", ok: true },
        { startDate: "2026-08-02", endDate: "2026-08-03", ok: false, message: "closed" },
      ],
    };
    const { adapter } = makeAdapter(CACHED_TWO);
    adapter.pushCells = async (cells) => cells.map((cell) => ({ cell, ok: true, jobReference: "job-king" }));
    adapter.fetchJobOutcomes = async (refs) => (asked.push(...refs), { "job-king": outcome as never });
    let calls = 0;
    const db = rawFakeSupabase(
      {
        hotel_settings: [{ hotel_id: "hotel-1", simulation_mode: false }],
        room_types: ROOM_TYPES.map((r) => ({ ...r, hotel_id: "hotel-1" })),
        published_price: NIGHTS.map((d) => ({ hotel_id: "hotel-1", stay_date: d, room_type_id: "rt-king", price: 210, computed_at: JUST_NOW })),
        base_rate_calendar: NIGHTS.map((d) => ({ hotel_id: "hotel-1", stay_date: d, room_type_id: "rt-king", price: 100 })),
        pms_connections: [{ id: "conn-1", hotel_id: "hotel-1", pms_type: "cloudbeds", push_rate_targets: CACHED_TWO }],
        rate_updates: [],
      },
      {
        // The correction write is the third rate_updates upsert (in progress, sent, correction).
        fault: (c) => (c.table === "rate_updates" && c.op === "upsert" && ++calls === 3 ? { message: "connection reset" } : null),
      },
    );
    await pushRatesForHotel(db.client, "hotel-1", adapter, WIDE);
    expect(db.tables.rate_updates.every((r) => r.status === "sent" && r.confirmed_at == null)).toBe(true);
  });
});
