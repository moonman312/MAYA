import { afterEach, describe, expect, it, vi } from "vitest";
import {
  pushRatesForHotel,
  type CellPushResult,
  type PmsRatePushAdapter,
  type RateCell,
  type RateTargetMap,
} from "../../../supabase/functions/_shared/pms/rate-push";
import type { SupabaseClient } from "@supabase/supabase-js";

type Row = Record<string, unknown>;

type Fixture = {
  publishedPrice?: Row[];
  roomTypes?: Row[];
  ledger?: Row[];
  connection?: Row | null;
};

type Chain = {
  select: () => Chain;
  eq: () => Chain;
  gte: () => Chain;
  lte: () => Chain;
  order: () => Chain;
  range: () => Promise<{ data: Row[]; error: null }>;
  maybeSingle: () => Promise<{ data: Row | null; error: null }>;
  upsert: (rows: Row[]) => Promise<{ error: null }>;
  update: (patch: Row) => Chain;
};

/** Minimal chainable stub covering the query shapes pushRatesForHotel uses. */
function makeSupabaseStub(fx: Fixture) {
  const connectionUpdates: Row[] = [];
  const ledgerUpserts: Row[] = [];
  const reads: Record<string, Row[]> = {
    published_price: fx.publishedPrice ?? [],
    room_types: fx.roomTypes ?? [],
    rate_updates: fx.ledger ?? [],
  };

  function table(name: string): Chain {
    const chain: Chain = {
      select: () => chain,
      eq: () => chain,
      gte: () => chain,
      lte: () => chain,
      order: () => chain,
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
        ledgerUpserts.push(...rows);
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
  };
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

const ROOM_TYPES: Row[] = [
  { id: "rt-king", external_room_type_id: "CB-KING" },
  { id: "rt-queen", external_room_type_id: "CB-QUEEN" },
];

const ROOM_TYPES_PLUS_SUITE: Row[] = [
  ...ROOM_TYPES,
  { id: "rt-suite", external_room_type_id: "CB-SUITE" },
];

const PRICES_TWO: Row[] = [
  { stay_date: "2026-08-01", room_type_id: "rt-king", price: 210 },
  { stay_date: "2026-08-01", room_type_id: "rt-queen", price: 180 },
];

const PRICES_THREE: Row[] = [
  ...PRICES_TWO,
  { stay_date: "2026-08-01", room_type_id: "rt-suite", price: 340 },
];

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

    const summary = await pushRatesForHotel(db.supabase, "hotel-1", adapter);

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

    const summary = await pushRatesForHotel(db.supabase, "hotel-1", adapter);

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

    const summary = await pushRatesForHotel(db.supabase, "hotel-1", adapter);

    expect(summary).toMatchObject({ pushed: true, sent: 1, failed: 1 });
    expect(db.connectionUpdates).toEqual([{ push_rate_targets: null }]);
    const kingLedger = db.ledgerUpserts.find((r) => r.room_type_id === "rt-king");
    expect(kingLedger).toMatchObject({ status: "failed", error: "rate not found" });
  });

  it("keeps a working cache when the catalog read comes back empty", async () => {
    const db = makeSupabaseStub({
      publishedPrice: PRICES_THREE,
      roomTypes: ROOM_TYPES_PLUS_SUITE,
      connection: { id: "conn-1", push_rate_targets: { ...CACHED_TWO } },
    });
    const { adapter, calls } = makeAdapter({});

    const summary = await pushRatesForHotel(db.supabase, "hotel-1", adapter);

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

    const summary = await pushRatesForHotel(db.supabase, "hotel-1", adapter);

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

    await expect(pushRatesForHotel(db.supabase, "hotel-1", adapter)).rejects.toThrow(/getRatePlans/);
  });

  it("does not drop targets it just resolved when the push still fails", async () => {
    const db = makeSupabaseStub({
      publishedPrice: PRICES_TWO,
      roomTypes: ROOM_TYPES,
      connection: { id: "conn-1", push_rate_targets: null },
    });
    const { adapter } = makeAdapter(CACHED_TWO, "CB-KING");

    await pushRatesForHotel(db.supabase, "hotel-1", adapter);

    expect(db.connectionUpdates).toEqual([{ push_rate_targets: CACHED_TWO }]);
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
        { stay_date: "2026-08-01", room_type_id: "rt-king", price: 210, status: "failed", attempts: 10 },
      ],
      connection: { id: "conn-1", push_rate_targets: { ...CACHED_TWO } },
    });
    const { adapter, attempts } = makeAdapter(CACHED_TWO);

    const summary = await pushRatesForHotel(db.supabase, "hotel-1", adapter);

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

    await pushRatesForHotel(db.supabase, "hotel-1", adapter);

    const kingLedger = db.ledgerUpserts.find((r) => r.room_type_id === "rt-king");
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

    const summary = await pushRatesForHotel(db.supabase, "hotel-1", adapter);

    expect(summary).toMatchObject({ pushed: true, failed: 1, skippedExhausted: 0 });
    expect(attempts.map((a) => a.externalRoomTypeId)).toContain("CB-KING");
    const kingLedger = db.ledgerUpserts.find((r) => r.room_type_id === "rt-king");
    expect(kingLedger).toMatchObject({ status: "failed", attempts: 1 });
  });
});

describe("pushRatesForHotel against a deadline", () => {
  it("stops between batches once the deadline passes, and leaves the rest unrecorded for the next tick", async () => {
    const prices: Row[] = [];
    for (let d = 0; d < 400; d++) {
      const day = new Date(Date.UTC(2026, 7, 1) + d * 86_400_000).toISOString().slice(0, 10);
      prices.push({ stay_date: day, room_type_id: "rt-king", price: 200 + d }, { stay_date: day, room_type_id: "rt-queen", price: 150 + d });
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
    const res = await pushRatesForHotel(db.supabase, "hotel-1", adapter, { pushHorizonDays: 365, deadlineAt: 1_000_000 + 8_000 });
    vi.restoreAllMocks();
    // 800 changed cells in batches of 300: two batches fit, the last 200 wait.
    expect(res).toMatchObject({ pushed: true, sent: 600, deferred: 200 });
    expect(attempts).toHaveLength(600);
    // Nearest nights went first.
    expect(db.ledgerUpserts.map((r) => r.stay_date).sort().at(-1)).toBe("2027-05-27"); // night 299 of 400
    expect(db.ledgerUpserts).toHaveLength(600);
  });
});

describe("pushRatesForHotel asks again about earlier jobs", () => {
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
    const res = await pushRatesForHotel(db.supabase, "hotel-1", adapter, { deadlineAt: Date.now() + 1000 });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(res).toMatchObject({ sent: 2, jobsConfirmed: 0, jobsRejected: 0 });
    expect(asked).toEqual([["job-1"]]);
    expect(db.ledgerUpserts.map((r) => r.status)).toEqual(["sent", "sent"]);
  });

  it("flips an earlier run's cells to failed when their job turns out rejected, even with nothing new to send", async () => {
    const ledger: Row[] = [
      { stay_date: "2026-08-01", room_type_id: "rt-king", external_room_type_id: "CB-KING", price: 210, status: "sent", attempts: 1, pms_job_reference: "job-old", pushed_at: minutesAgo(10) },
      { stay_date: "2026-08-01", room_type_id: "rt-queen", external_room_type_id: "CB-QUEEN", price: 180, status: "sent", attempts: 1, pms_job_reference: "job-old", pushed_at: minutesAgo(10) },
    ];
    const db = makeSupabaseStub({ publishedPrice: PRICES_TWO, roomTypes: ROOM_TYPES, ledger, connection: { id: "conn-1", push_rate_targets: CACHED_TWO } });
    const { adapter, attempts, asked } = jobAdapter(() => ({ "job-old": { done: true, ok: false, message: "rate closed" } }));
    const res = await pushRatesForHotel(db.supabase, "hotel-1", adapter);
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
      publishedPrice: [...PRICES_TWO, { stay_date: "2026-08-02", room_type_id: "rt-queen", price: 180 }],
      roomTypes: ROOM_TYPES,
      ledger,
      connection: { id: "conn-1", push_rate_targets: CACHED_TWO },
    });
    const { adapter, asked } = jobAdapter((refs) => Object.fromEntries(refs.map((r) => [r, { done: true, ok: false, message: "no" }])));
    const res = await pushRatesForHotel(db.supabase, "hotel-1", adapter);
    expect(asked).toEqual([["job-1"]]);
    expect(res).toMatchObject({ sent: 1, jobsRejected: 1 });
    const failed = db.ledgerUpserts.filter((r) => r.status === "failed");
    expect(failed.map((r) => `${r.stay_date}|${r.room_type_id}|${r.pms_job_reference}`)).toEqual(["2026-08-01|rt-king|job-1"]);
  });
});
