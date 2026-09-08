import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const client = vi.hoisted(() => {
  const activeReservation = {
    id: "res_1",
    status: "scheduled",
    // 02:00 UTC is the evening of the 24th in Los Angeles — the parse must
    // date the booking on the hotel's calendar, not UTC's.
    createdAt: "2026-07-25T02:00:00Z",
    bookings: [
      {
        id: "b1",
        roomTypeId: "rt_king",
        startDate: "2026-08-02",
        endDate: "2026-08-03",
        status: "scheduled",
      },
    ],
    lineItems: [
      { billingType: "RoomLineItem", bookingId: "b1", billingDate: "2026-08-02T12:00:00Z", amount: 100 },
    ],
  };
  const state = { pages: [[activeReservation]] as unknown[][] };
  // Mirrors the real pager's contract: `last` says whether more pages exist,
  // and the sync decides after each page whether to ask for the next.
  const servePage = async (_creds: unknown, _hotelId: unknown, _range: unknown, page: number) => ({
    content: state.pages[page] ?? [],
    totalPages: state.pages.length,
    last: page >= state.pages.length - 1,
    number: page,
  });
  return {
    activeReservation,
    state,
    servePage,
    thinkGetHotels: vi.fn(),
    thinkGetRoomTypes: vi.fn(),
    thinkGetReservationsPage: vi.fn(servePage),
  };
});

// Only the network functions are faked; buildReservationRangeParams runs for
// real so these tests pin the wire's actual parameter names.
vi.mock("../../../supabase/functions/_shared/think/client.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../supabase/functions/_shared/think/client")>();
  return {
    ...actual,
    thinkGetHotels: client.thinkGetHotels,
    thinkGetRoomTypes: client.thinkGetRoomTypes,
    thinkGetReservationsPage: client.thinkGetReservationsPage,
  };
});

const oauth = vi.hoisted(() => ({
  resolveOAuthCredentials: vi.fn(),
  persistPropertyId: vi.fn(async () => {}),
}));
vi.mock("../../../supabase/functions/_shared/pms/oauth-credentials.ts", () => oauth);

import { runThinkSyncForHotel } from "../../../supabase/functions/_shared/think/sync-hotel";
import { redactThinkPayload } from "../../../supabase/functions/_shared/think/etl";

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

  /** The read-backs (row diff, stale nights): filtered rows, sliced like .range(). */
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

beforeEach(() => {
  client.state.pages = [[client.activeReservation]];
  client.thinkGetHotels.mockReset();
  client.thinkGetHotels.mockResolvedValue([{ id: "h-1", externalId: "prop-1", name: "Harbor Inn" }]);
  client.thinkGetRoomTypes.mockReset();
  client.thinkGetRoomTypes.mockResolvedValue([{ id: "rt_king", name: "King" }]);
  client.thinkGetReservationsPage.mockReset();
  client.thinkGetReservationsPage.mockImplementation(client.servePage);
  oauth.resolveOAuthCredentials.mockReset();
  oauth.resolveOAuthCredentials.mockResolvedValue({
    accessToken: "at",
    tokenType: "Bearer",
    scope: null,
    expiresAt: null,
    propertyId: "prop-1",
    refreshed: false,
  });
  oauth.persistPropertyId.mockClear();
});

describe("runThinkSyncForHotel room type upsert", () => {
  it("leaves a room type the owner excluded deactivated", async () => {
    const supabase = makeSupabaseStub([
      { external_room_type_id: "rt_king", name: "King", is_active: false },
    ]);

    const result = await runThinkSyncForHotel(supabase, "hotel-1");

    expect(result.ok).toBe(true);
    expect(supabase.roomTypes[0].is_active).toBe(false);
    expect(Object.keys(supabase.roomTypeUpserts[0])).not.toContain("is_active");
  });

  it("still takes the insert default for a type it has never seen", async () => {
    const supabase = makeSupabaseStub();

    const result = await runThinkSyncForHotel(supabase, "hotel-1");

    expect(result.ok).toBe(true);
    expect(supabase.roomTypes).toHaveLength(1);
    expect(supabase.roomTypes[0].is_active).toBe(true);
    // Think's RoomType carries no inventory count, so the hotel default fills in.
    expect(supabase.roomTypes[0].total_rooms).toBe(10);
  });
});

describe("runThinkSyncForHotel hotel row read", () => {
  it("aborts instead of syncing a west-of-UTC hotel as if it were UTC", async () => {
    const supabase = makeSupabaseStub([], "canceling statement due to statement timeout");

    const result = await runThinkSyncForHotel(supabase, "hotel-1");

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("statement timeout") });
    expect(supabase.roomTypeUpserts).toEqual([]);
  });
});

describe("runThinkSyncForHotel hotel id discovery", () => {
  it("discovers and persists the sole hotel's externalId when none is stored", async () => {
    oauth.resolveOAuthCredentials.mockResolvedValue({
      accessToken: "at",
      tokenType: "Bearer",
      scope: null,
      expiresAt: null,
      propertyId: null,
      refreshed: false,
    });
    client.thinkGetHotels.mockResolvedValue([{ id: "h-9", externalId: "prop-9", name: "Solo Inn" }]);
    const supabase = makeSupabaseStub();

    const result = await runThinkSyncForHotel(supabase, "hotel-1");

    expect(result.ok).toBe(true);
    expect(oauth.persistPropertyId).toHaveBeenCalledWith(supabase, "hotel-1", "think", "prop-9");
    expect(client.thinkGetReservationsPage.mock.calls[0][1]).toBe("prop-9");
  });

  it("refuses to guess between several hotels on one token", async () => {
    oauth.resolveOAuthCredentials.mockResolvedValue({
      accessToken: "at",
      tokenType: "Bearer",
      scope: null,
      expiresAt: null,
      propertyId: null,
      refreshed: false,
    });
    client.thinkGetHotels.mockResolvedValue([
      { id: "h-1", externalId: "prop-1", name: "North" },
      { id: "h-2", externalId: "prop-2", name: "South" },
    ]);
    const supabase = makeSupabaseStub();

    const result = await runThinkSyncForHotel(supabase, "hotel-1");

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("externalId") });
    expect(client.thinkGetReservationsPage).not.toHaveBeenCalled();
    expect(oauth.persistPropertyId).not.toHaveBeenCalled();
  });
});

describe("runThinkSyncForHotel sync modes and checkpoints", () => {
  const T0 = new Date("2026-08-05T10:00:00Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("pulls incrementally once a watermark and a recent full sweep exist", async () => {
    const supabase = makeSupabaseStub([], undefined, [], {
      id: "conn-1",
      reservations_modified_through: "2026-08-05T09:50:00.000Z",
      last_full_sync_at: "2026-08-05T02:00:00.000Z",
    });

    const res = await runThinkSyncForHotel(supabase, "hotel-1");
    expect(res.ok).toBe(true);

    // Ten minutes behind the watermark, up to now — change-time, not stay-time.
    const [, , range, page, size] = client.thinkGetReservationsPage.mock.calls[0] as unknown as
      [unknown, unknown, unknown, number, number];
    expect(range).toEqual({
      updated_at_start_date_time: "2026-08-05T09:40:00.000Z",
      updated_at_end_date_time: "2026-08-05T10:00:00.000Z",
    });
    expect(page).toBe(0);
    expect(size).toBe(200);

    const stamp = supabase.connUpdates.at(-1)!;
    expect(stamp.reservations_modified_through).toBe(T0.toISOString());
    expect(stamp).not.toHaveProperty("last_full_sync_at");
  });

  it("sweeps the stay window in full on first run, with no updated filter", async () => {
    const supabase = makeSupabaseStub([], undefined, [], { id: "conn-1" });

    const res = await runThinkSyncForHotel(supabase, "hotel-1");
    expect(res.ok).toBe(true);

    const [, , range, page] = client.thinkGetReservationsPage.mock.calls[0];
    expect(range).toEqual({
      stay_on_start_date: "2026-07-06",
      stay_on_end_date: "2027-09-05",
    });
    expect(page).toBe(0);

    const stamp = supabase.connUpdates.at(-1)!;
    expect(stamp.reservations_modified_through).toBe(T0.toISOString());
    expect(stamp.last_full_sync_at).toBe(T0.toISOString());
    expect(stamp.full_sweep_after_id).toBeNull();
  });

  it("checkpoints the page a budget-cut sweep finished, without moving the watermark", async () => {
    const supabase = makeSupabaseStub([], undefined, [], { id: "conn-1" });
    client.thinkGetReservationsPage.mockImplementation(async (_c, _h, _r, page: number) => {
      // The budget burns down while page 0 is in flight…
      vi.advanceTimersByTime(300_000);
      return { content: client.state.pages[page] ?? [], totalPages: 2, last: false, number: page };
    });

    const res = await runThinkSyncForHotel(supabase, "hotel-1");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.windowFullyCovered).toBe(false);

    // …so the sync stops after writing it, one page into two.
    expect(client.thinkGetReservationsPage).toHaveBeenCalledTimes(1);
    const stamp = supabase.connUpdates.at(-1)!;
    expect(stamp.full_sweep_after_id).toBe("0");
    expect(stamp.full_sweep_started_at).toBe(T0.toISOString());
    expect(stamp).not.toHaveProperty("reservations_modified_through");
    expect(stamp).not.toHaveProperty("last_full_sync_at");
  });

  it("resumes past the checkpoint on the sweep's own stay grid and stamps from its start", async () => {
    const sweepStart = "2026-08-04T09:45:00.000Z";
    const supabase = makeSupabaseStub([], undefined, [], {
      id: "conn-1",
      full_sweep_after_id: "0",
      full_sweep_started_at: sweepStart,
    });
    client.state.pages = [[], [client.activeReservation]];

    const res = await runThinkSyncForHotel(supabase, "hotel-1");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.windowFullyCovered).toBe(true);

    // One call, straight to page 1 — and the stay range is anchored to the
    // sweep's start, not to now, so page 1 means the same slice it meant
    // yesterday.
    expect(client.thinkGetReservationsPage).toHaveBeenCalledTimes(1);
    const [, , range, page] = client.thinkGetReservationsPage.mock.calls[0];
    expect(page).toBe(1);
    expect(range).toEqual({
      stay_on_start_date: "2026-07-05",
      stay_on_end_date: "2027-09-04",
    });

    const stamp = supabase.connUpdates.at(-1)!;
    expect(stamp.reservations_modified_through).toBe(sweepStart);
    expect(stamp.last_full_sync_at).toBe(sweepStart);
    expect(stamp.full_sweep_after_id).toBeNull();
    expect(stamp.full_sweep_started_at).toBeNull();
  });

  it("an explicit window never records a checkpoint, and clears any stale one", async () => {
    const supabase = makeSupabaseStub([], undefined, [], {
      id: "conn-1",
      // A sweep was mid-flight when someone asked for this window; completing
      // it advances the watermark past that sweep's anchor, so resuming the
      // stale grid later would only force a redundant second sweep.
      full_sweep_after_id: "3",
      full_sweep_started_at: "2026-08-05T01:00:00.000Z",
    });

    const res = await runThinkSyncForHotel(supabase, "hotel-1", { daysBack: 5 });
    expect(res.ok).toBe(true);

    const [, , range, page] = client.thinkGetReservationsPage.mock.calls[0];
    expect(page).toBe(0);
    expect(range).toMatchObject({ stay_on_start_date: "2026-07-31" });

    const stamp = supabase.connUpdates.at(-1)!;
    expect(stamp.full_sweep_after_id).toBeNull();
    expect(stamp.full_sweep_started_at).toBeNull();
    expect(stamp.reservations_modified_through).toBe(T0.toISOString());
  });

  it("deletes a cancellation's rows straight out of the incremental pull", async () => {
    // No separate cancellation pass exists: canceling modifies the
    // reservation, so it arrives in the updated_at pull with status canceled.
    const supabase = makeSupabaseStub([], undefined, [
      { external_reservation_id: "res_gone", stay_date: "2026-08-10", current_rate: 90 },
    ], {
      id: "conn-1",
      reservations_modified_through: "2026-08-05T09:50:00.000Z",
      last_full_sync_at: "2026-08-05T02:00:00.000Z",
    });
    client.state.pages = [[
      client.activeReservation,
      {
        id: "res_gone",
        status: "canceled",
        bookings: [{ id: "bg", startDate: "2026-08-10", endDate: "2026-08-11", status: "canceled" }],
      },
    ]];

    const res = await runThinkSyncForHotel(supabase, "hotel-1");
    expect(res.ok).toBe(true);

    expect(
      supabase.reservations.filter((r) => r.external_reservation_id === "res_gone"),
    ).toEqual([]);
    // The active booking on the same page still landed.
    expect(
      supabase.reservations.filter((r) => r.external_reservation_id === "res_1:b1"),
    ).toHaveLength(1);
    if (res.ok) expect(res.ingest.skippedCanceled).toBe(1);
  });
});

describe("runThinkSyncForHotel row diff", () => {
  it("skips rows whose stored copy already matches instead of rewriting them", async () => {
    const booking = (client.activeReservation as { bookings: Row[] }).bookings[0];
    const supabase = makeSupabaseStub(
      [{ external_room_type_id: "rt_king", name: "King" }],
      undefined,
      [
        {
          external_reservation_id: "res_1:b1",
          room_type_id: "rt-uuid-1",
          stay_date: "2026-08-02",
          booking_date: "2026-07-24",
          booking_window_days: 9,
          current_rate: 100,
          raw_payload: redactThinkPayload(client.activeReservation as never, booking as never),
        },
      ],
    );

    const result = await runThinkSyncForHotel(supabase, "hotel-1");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ingest.unchangedRowsSkipped).toBe(1);
      expect(result.reservationRowsUpserted).toBe(0);
    }
  });
});
