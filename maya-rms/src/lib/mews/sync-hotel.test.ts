import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const client = vi.hoisted(() => {
  class MewsHttpError extends Error {}
  return {
    MewsHttpError,
    mewsFetchReservationsRange: vi.fn(async () => ({
      data: {
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
      },
      windows: 1,
    })),
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
) {
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
        if (name !== "hotels") return { data: null, error: null };
        if (hotelReadError) return { data: null, error: { message: hotelReadError } };
        return { data: { total_rooms_per_type: 10, timezone: "America/Los_Angeles" }, error: null };
      },
      update: () => ({ eq: async () => ({ error: null }) }),
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

  return { from: table, roomTypes, roomTypeUpserts, reservations } as unknown as SupabaseClient & {
    roomTypes: Row[];
    roomTypeUpserts: Row[];
    reservations: Row[];
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
