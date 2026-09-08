import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const client = vi.hoisted(() => {
  class MewsHttpError extends Error {}
  const fixtureRaw = {
    Reservations: [
      {
        Id: "res_1",
        State: "Confirmed",
        ScheduledStartUtc: "2026-08-02T00:00:00Z",
        ScheduledEndUtc: "2026-08-03T18:00:00Z",
        CreatedUtc: "2026-07-25T02:00:00Z",
        SpaceCategoryId: "cat_king",
      },
    ],
    SpaceCategories: [{ Id: "cat_king", Name: "King", RoomCount: 8 }],
  };
  return {
    MewsHttpError,
    fixtureRaw,
    /** How many windows the fake range spans; each carries the fixture. */
    windowCount: { value: 1 },
    // Mirrors the real walk's contract: every window hands the caller its
    // payload, onWindow's verdict decides whether the walk continues, and
    // `completed` is whether the RANGE was covered — a refusal on the final
    // window still covered it.
    mewsWalkReservationWindows: vi.fn(
      async (
        _creds: unknown,
        startUtc: string,
        endUtc: string,
        onWindow: (v: { index: number; raw: Record<string, unknown>; startUtc: string; endUtc: string }) => Promise<boolean>,
        opts: { fromIndex?: number } = {},
      ) => {
        const count = client.windowCount.value;
        const fromIndex = opts.fromIndex ?? 0;
        let windowsFetched = 0;
        let lastIndex = fromIndex - 1;
        for (let i = fromIndex; i < count; i++) {
          windowsFetched += 1;
          lastIndex = i;
          const keep = await onWindow({ index: i, raw: fixtureRaw, startUtc, endUtc });
          if (!keep) return { windowsFetched, lastIndex, completed: i === count - 1 };
        }
        return { windowsFetched, lastIndex, completed: true };
      },
    ),
  };
});

vi.mock("../../../supabase/functions/_shared/mews/client.ts", () => client);
vi.mock("../../../supabase/functions/_shared/mews/resolve-credentials.ts", () => ({
  resolveMewsCredentials: vi.fn(async () => ({
    creds: { clientToken: "ct", accessToken: "at", baseUrl: "https://api.mews-demo.com" },
    connectionId: null,
    source: "body",
  })),
}));

import { runMewsSyncForHotel } from "../../../supabase/functions/_shared/mews/sync-hotel";

type Row = Record<string, unknown>;

/**
 * `room_types` modelled the way PostgREST writes it: an upsert only touches the
 * columns present in the payload, and an insert takes the schema defaults for the
 * rest (`is_active boolean not null default true`).
 */
function makeSupabaseStub(
  seedRoomTypes: Row[] = [],
  hotelReadError?: string,
  seedReservations: Row[] = [],
  syncState: Row = {},
) {
  const connUpdates: Row[] = [];
  const roomTypes: Row[] = seedRoomTypes.map((rt, i) => ({
    id: `rt-uuid-${i + 1}`,
    hotel_id: "hotel-1",
    is_active: true,
    ...rt,
  }));
  const roomTypeUpserts: Row[] = [];
  const reservations: Row[] = seedReservations.map((r) => ({ hotel_id: "hotel-1", ...r }));

  function deleteBuilder() {
    const preds: Array<(r: Row) => boolean> = [];
    const builder = {
      eq(col: string, val: unknown) {
        preds.push((r) => r[col] === val);
        return builder;
      },
      in(col: string, vals: unknown[]) {
        preds.push((r) => vals.includes(r[col]));
        return builder;
      },
      then<T>(resolve: (v: { error: null }) => T) {
        const survivors = reservations.filter((r) => !preds.every((p) => p(r)));
        reservations.length = 0;
        reservations.push(...survivors);
        return Promise.resolve({ error: null }).then(resolve);
      },
    };
    return builder;
  }

  /** The stale-night read-back: filtered rows, sliced the way .range() slices. */
  function resSelectBuilder() {
    const preds: Array<(r: Row) => boolean> = [];
    const builder = {
      eq(col: string, val: unknown) {
        preds.push((r) => r[col] === val);
        return builder;
      },
      in(col: string, vals: unknown[]) {
        preds.push((r) => vals.includes(r[col]));
        return builder;
      },
      range: async (from: number, to: number) => ({
        data: reservations.filter((r) => preds.every((p) => p(r))).slice(from, to + 1),
        error: null,
      }),
    };
    return builder;
  }

  function table(name: string) {
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => {
        if (name === "pms_connections") return { data: { ...syncState }, error: null };
        if (name !== "hotels") return { data: null, error: null };
        if (hotelReadError) return { data: null, error: { message: hotelReadError } };
        return { data: { total_rooms_per_type: 10, timezone: "America/Los_Angeles" }, error: null };
      },
      update: (payload: Row) => ({
        eq: async () => {
          if (name === "pms_connections") connUpdates.push(payload);
          return { error: null };
        },
      }),
      upsert: async (rows: Row | Row[]) => {
        const list = Array.isArray(rows) ? rows : [rows];
        if (name === "reservations") {
          for (const row of list) {
            const idx = reservations.findIndex(
              (r) =>
                r.hotel_id === row.hotel_id &&
                r.external_reservation_id === row.external_reservation_id &&
                r.stay_date === row.stay_date,
            );
            if (idx >= 0) reservations[idx] = row;
            else reservations.push(row);
          }
          return { error: null };
        }
        if (name !== "room_types") return { error: null };
        roomTypeUpserts.push(...list);
        for (const row of list) {
          const existing = roomTypes.find(
            (r) => r.external_room_type_id === row.external_room_type_id,
          );
          if (existing) Object.assign(existing, row);
          else roomTypes.push({ id: `rt-uuid-${roomTypes.length + 1}`, is_active: true, ...row });
        }
        return { error: null };
      },
      delete: deleteBuilder,
    };
    if (name === "room_types") {
      return {
        ...chain,
        select: () => ({ eq: async () => ({ data: roomTypes, error: null }) }),
      };
    }
    if (name === "reservations") {
      return { ...chain, select: resSelectBuilder };
    }
    return chain;
  }

  return { from: table, roomTypes, roomTypeUpserts, reservations, connUpdates } as unknown as SupabaseClient & {
    roomTypes: Row[];
    roomTypeUpserts: Row[];
    reservations: Row[];
    connUpdates: Row[];
  };
}

describe("runMewsSyncForHotel room type upsert", () => {
  it("leaves a room type the owner excluded deactivated", async () => {
    const supabase = makeSupabaseStub([
      { external_room_type_id: "cat_king", name: "King", is_active: false },
    ]);

    const result = await runMewsSyncForHotel(supabase, "hotel-1");

    expect(result.ok).toBe(true);
    expect(supabase.roomTypes[0].is_active).toBe(false);
    expect(Object.keys(supabase.roomTypeUpserts[0])).not.toContain("is_active");
  });

  it("still takes the insert default for a category it has never seen", async () => {
    const supabase = makeSupabaseStub();

    const result = await runMewsSyncForHotel(supabase, "hotel-1");

    expect(result.ok).toBe(true);
    expect(supabase.roomTypes).toHaveLength(1);
    expect(supabase.roomTypes[0].is_active).toBe(true);
    expect(supabase.roomTypes[0].total_rooms).toBe(8);
  });
});

describe("runMewsSyncForHotel stale-night reconcile", () => {
  it("prunes nights an active booking no longer holds, and only its own", async () => {
    const supabase = makeSupabaseStub([], undefined, [
      // A night res_1 held before its dates moved.
      { external_reservation_id: "res_1", stay_date: "2020-01-01", current_rate: 100 },
      // Same stale date, different booking — the grouped delete must not
      // sweep it up, and nothing this run mentions it.
      { external_reservation_id: "other", stay_date: "2020-01-01", current_rate: 100 },
    ]);

    const result = await runMewsSyncForHotel(supabase, "hotel-1");

    expect(result.ok).toBe(true);
    expect(
      supabase.reservations.filter(
        (r) => r.external_reservation_id === "res_1" && r.stay_date === "2020-01-01",
      ),
    ).toEqual([]);
    expect(
      supabase.reservations.filter((r) => r.external_reservation_id === "other"),
    ).toHaveLength(1);
    // The booking's current nights were written, not lost with the stale one.
    expect(
      supabase.reservations.filter((r) => r.external_reservation_id === "res_1").length,
    ).toBeGreaterThan(0);
  });
});

describe("runMewsSyncForHotel hotel row read", () => {
  it("aborts instead of syncing a west-of-UTC hotel as if it were UTC", async () => {
    const supabase = makeSupabaseStub([], "canceling statement due to statement timeout");

    const result = await runMewsSyncForHotel(supabase, "hotel-1");

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("statement timeout") });
    expect(supabase.roomTypeUpserts).toEqual([]);
  });
});

import { resolveMewsCredentials } from "../../../supabase/functions/_shared/mews/resolve-credentials";

describe("runMewsSyncForHotel sync modes and checkpoints", () => {
  const T0 = new Date("2026-08-05T10:00:00Z");

  function withConnection() {
    vi.mocked(resolveMewsCredentials).mockResolvedValueOnce({
      creds: { clientToken: "ct", accessToken: "at", baseUrl: "https://api.mews-demo.com" },
      connectionId: "conn-1",
      source: "body",
    } as never);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    client.windowCount.value = 1;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("pulls incrementally once a watermark and a recent full sweep exist", async () => {
    withConnection();
    const watermark = "2026-08-05T09:50:00.000Z";
    const supabase = makeSupabaseStub([], undefined, [], {
      id: "conn-1",
      reservations_modified_through: watermark,
      last_full_sync_at: "2026-08-05T02:00:00.000Z",
    });

    const res = await runMewsSyncForHotel(supabase, "hotel-1");
    expect(res.ok).toBe(true);

    const [, start, end, , opts] = client.mewsWalkReservationWindows.mock.calls.at(-1)!;
    expect(opts).toMatchObject({ timeFilter: "Updated" });
    // Ten minutes behind the watermark, up to now.
    expect(start).toBe("2026-08-05T09:40:00Z");
    expect(end).toBe("2026-08-05T10:00:00Z");

    const stamp = supabase.connUpdates.at(-1)!;
    expect(stamp.reservations_modified_through).toBe(T0.toISOString());
    expect(stamp).not.toHaveProperty("last_full_sync_at");
  });

  it("sweeps in full on first run, with no Updated filter", async () => {
    withConnection();
    const supabase = makeSupabaseStub([], undefined, [], { id: "conn-1" });

    const res = await runMewsSyncForHotel(supabase, "hotel-1");
    expect(res.ok).toBe(true);

    const [, , , , opts] = client.mewsWalkReservationWindows.mock.calls.at(-1)!;
    expect(opts).toMatchObject({ timeFilter: undefined, fromIndex: 0 });

    const stamp = supabase.connUpdates.at(-1)!;
    expect(stamp.reservations_modified_through).toBe(T0.toISOString());
    expect(stamp.last_full_sync_at).toBe(T0.toISOString());
    expect(stamp.full_sweep_after_id).toBeNull();
  });

  it("checkpoints a sweep the budget cut short, without moving the watermark", async () => {
    withConnection();
    const supabase = makeSupabaseStub([], undefined, [], { id: "conn-1" });
    client.mewsWalkReservationWindows.mockImplementationOnce(
      async (_c: unknown, s2: string, e2: string, onWindow: (v: never) => Promise<boolean>) => {
        // The budget burns down while window 0 is being processed…
        vi.advanceTimersByTime(300_000);
        const keep = await onWindow({ index: 0, raw: client.fixtureRaw, startUtc: s2, endUtc: e2 } as never);
        // …so the sync tells the walk to stop, one window into two.
        expect(keep).toBe(false);
        return { windowsFetched: 1, lastIndex: 0, completed: false };
      },
    );

    const res = await runMewsSyncForHotel(supabase, "hotel-1");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.windowFullyCovered).toBe(false);

    const stamp = supabase.connUpdates.at(-1)!;
    expect(stamp.full_sweep_after_id).toBe("0");
    expect(stamp.full_sweep_started_at).toBe(T0.toISOString());
    expect(stamp).not.toHaveProperty("reservations_modified_through");
    expect(stamp).not.toHaveProperty("last_full_sync_at");
  });

  it("resumes past the checkpoint and stamps the watermark from the sweep's start", async () => {
    withConnection();
    const sweepStart = "2026-08-05T09:45:00.000Z";
    const supabase = makeSupabaseStub([], undefined, [], {
      id: "conn-1",
      full_sweep_after_id: "0",
      full_sweep_started_at: sweepStart,
    });
    client.windowCount.value = 2;

    const res = await runMewsSyncForHotel(supabase, "hotel-1");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.windowFullyCovered).toBe(true);

    const [, , , , opts] = client.mewsWalkReservationWindows.mock.calls.at(-1)!;
    expect(opts).toMatchObject({ fromIndex: 1 });

    const stamp = supabase.connUpdates.at(-1)!;
    expect(stamp.reservations_modified_through).toBe(sweepStart);
    expect(stamp.last_full_sync_at).toBe(sweepStart);
    expect(stamp.full_sweep_after_id).toBeNull();
    expect(stamp.full_sweep_started_at).toBeNull();
  });

  it("an explicit window never records a checkpoint, and clears any stale one", async () => {
    withConnection();
    const supabase = makeSupabaseStub([], undefined, [], {
      id: "conn-1",
      // A sweep was mid-flight when someone asked for this window; completing
      // it advances the watermark past that sweep's anchor, so resuming the
      // stale grid later would only force a redundant second sweep.
      full_sweep_after_id: "3",
      full_sweep_started_at: "2026-08-05T01:00:00.000Z",
    });

    const res = await runMewsSyncForHotel(supabase, "hotel-1", { daysBack: 5 });
    expect(res.ok).toBe(true);

    const stamp = supabase.connUpdates.at(-1)!;
    expect(stamp.full_sweep_after_id).toBeNull();
    expect(stamp.full_sweep_started_at).toBeNull();
    expect(stamp.reservations_modified_through).toBe(T0.toISOString());
  });
});
