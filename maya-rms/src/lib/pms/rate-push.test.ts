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
