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
function makeSupabaseStub(seedRoomTypes: Row[] = [], hotelReadError?: string) {
  const roomTypes: Row[] = seedRoomTypes.map((rt, i) => ({
    id: `rt-uuid-${i + 1}`,
    hotel_id: "hotel-1",
    is_active: true,
    ...rt,
  }));
  const roomTypeUpserts: Row[] = [];

  function deleteBuilder() {
    const builder = {
      eq: () => builder,
      in: () => builder,
      not: () => builder,
      then: <T>(resolve: (v: { error: null }) => T) => Promise.resolve({ error: null }).then(resolve),
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
    return chain;
  }

  return { from: table, roomTypes, roomTypeUpserts } as unknown as SupabaseClient & {
    roomTypes: Row[];
    roomTypeUpserts: Row[];
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

describe("runMewsSyncForHotel hotel row read", () => {
  it("aborts instead of syncing a west-of-UTC hotel as if it were UTC", async () => {
    const supabase = makeSupabaseStub([], "canceling statement due to statement timeout");

    const result = await runMewsSyncForHotel(supabase, "hotel-1");

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("statement timeout") });
    expect(supabase.roomTypeUpserts).toEqual([]);
  });
});
