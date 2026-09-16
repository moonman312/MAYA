import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const client = vi.hoisted(() => {
  class CloudbedsHttpError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly path: string,
    ) {
      super(message);
      this.name = "CloudbedsHttpError";
    }
  }
  return {
    CloudbedsHttpError,
    setCloudbedsRequestLogger: vi.fn(),
    cloudbedsDiscoverPropertyId: vi.fn(async () => "prop-1"),
    cloudbedsGetTaxesAndFees: vi.fn(async () => ({ ok: false, reason: "not_granted" })),
    cloudbedsGetRoomTypes: vi.fn(async () => [
      { roomTypeID: "RT1", roomTypeName: "King", roomTypeUnits: 10 },
    ]),
    cloudbedsGetReservationsRange: vi.fn(),
    cloudbedsGetReservationsPage: vi.fn(),
    cloudbedsGetReservationDetail: vi.fn(),
    // The wire format, unmocked in spirit: a sync that persists its own
    // watermark goes incremental on the next run and formats it with this.
    cloudbedsTimestamp: (d: Date) => d.toISOString().slice(0, 19).replace("T", " "),
  };
});

vi.mock("../../../supabase/functions/_shared/cloudbeds/client.ts", () => client);
vi.mock("../../../supabase/functions/_shared/cloudbeds/request-log.ts", () => ({
  installCloudbedsRequestLogging: vi.fn(),
}));
vi.mock("../../../supabase/functions/_shared/pms/oauth-credentials.ts", () => ({
  resolveOAuthCredentials: vi.fn(async () => ({
    accessToken: "cbat_test",
    tokenType: "Bearer",
    propertyId: "prop-1",
    refreshed: false,
  })),
  persistPropertyId: vi.fn(),
}));

import { runCloudbedsSyncForHotel } from "../../../supabase/functions/_shared/cloudbeds/sync-hotel";
import { computeOccupancy } from "../../../supabase/functions/_shared/engine/metrics";
import { snapshotCurrentState } from "../../../supabase/functions/_shared/engine/snapshots";
import type { RoomTypeRow } from "../../../supabase/functions/_shared/engine/types";
import { fakeSupabase } from "../engine/fake-supabase.test";

type ResRow = Record<string, unknown>;

/**
 * In-memory `reservations` table. The point of these tests is which rows
 * survive a sync, so deletes actually have to filter rather than be recorded.
 */
function makeSupabaseStub(seed: ResRow[] = [], syncState: ResRow = {}) {
  const reservations: ResRow[] = seed.map((r) => ({ hotel_id: "hotel-1", ...r }));
  const roomTypeUpserts: ResRow[] = [];
  const connUpdates: ResRow[] = [];
  // The one connection row. Its status matters because the stamp is
  // conditional on it; the id filter always matches, so it is not modelled.
  const connection: ResRow = { id: "conn-1", status: "connected", ...syncState };

  /** An UPDATE that only lands when its .in() conditions hold for the row. */
  function updateBuilder(name: string, payload: ResRow) {
    const preds: Array<(r: ResRow) => boolean> = [];
    const apply = () => {
      if (name !== "pms_connections" || !preds.every((p) => p(connection))) return false;
      Object.assign(connection, payload);
      connUpdates.push(payload);
      return true;
    };
    const builder = {
      eq: () => builder,
      in(col: string, vals: unknown[]) {
        preds.push((r) => vals.includes(r[col]));
        return builder;
      },
      select: async () => ({ data: apply() ? [{ id: connection.id }] : [], error: null }),
      then<T>(resolve: (v: { error: null }) => T) {
        apply();
        return Promise.resolve({ error: null }).then(resolve);
      },
    };
    return builder;
  }

  function deleteBuilder() {
    const preds: Array<(r: ResRow) => boolean> = [];
    const builder = {
      eq(col: string, val: unknown) {
        preds.push((r) => r[col] === val);
        return builder;
      },
      in(col: string, vals: unknown[]) {
        preds.push((r) => vals.includes(r[col]));
        return builder;
      },
      not(col: string, op: string, list: string) {
        if (op !== "in") throw new Error(`unsupported not(${op})`);
        const keep = new Set(list.replace(/^\(|\)$/g, "").split(","));
        preds.push((r) => !keep.has(String(r[col])));
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
    const preds: Array<(r: ResRow) => boolean> = [];
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
        if (name === "pms_connections") return { data: { id: "conn-1", base_url: null, ...syncState } };
        if (name === "hotels") return { data: { total_rooms_per_type: 10 } };
        return { data: null };
      },
      update: (payload: ResRow) => updateBuilder(name, payload),
      upsert: async (rows: ResRow | ResRow[]) => {
        if (name === "room_types") {
          roomTypeUpserts.push(...(Array.isArray(rows) ? rows : [rows]));
          return { error: null };
        }
        if (name !== "reservations") return { error: null };
        for (const row of Array.isArray(rows) ? rows : [rows]) {
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
      },
      delete: deleteBuilder,
    };
    if (name === "room_types") {
      return {
        ...chain,
        select: () => ({
          eq: async () => ({ data: [{ id: "rt-uuid-1", external_room_type_id: "RT1" }] }),
        }),
      };
    }
    if (name === "reservations") {
      return { ...chain, select: resSelectBuilder };
    }
    return chain;
  }

  return { from: table, reservations, roomTypeUpserts, connUpdates, connection } as unknown as SupabaseClient & {
    reservations: ResRow[];
    roomTypeUpserts: ResRow[];
    connUpdates: ResRow[];
    connection: ResRow;
  };
}

/** A getReservation detail payload with one assigned room and three nights. */
function detailFor(rid: string, subId: string, status: string) {
  return {
    reservationID: rid,
    status,
    dateCreated: "2026-07-01",
    assigned: [
      {
        subReservationID: subId,
        roomTypeID: "RT1",
        dailyRates: [
          { date: "2026-08-15", rate: 200 },
          { date: "2026-08-16", rate: 200 },
          { date: "2026-08-17", rate: 200 },
        ],
      },
    ],
  };
}

function activeList(...ids: string[]) {
  client.cloudbedsGetReservationsRange.mockResolvedValue({
    reservations: ids.map((id) => ({ reservationID: id })),
    pages: 1,
  });
}

/** Serve `ids` under the canceled status filters, nothing under anything else. */
function canceledList(...ids: string[]) {
  client.cloudbedsGetReservationsPage.mockImplementation(
    async (_creds: unknown, _from: string, _to: string, status: string) => ({
      reservations:
        status === "canceled" ? ids.map((id) => ({ reservationID: id })) : [],
      hasMore: false,
    }),
  );
}

beforeEach(() => {
  client.cloudbedsGetReservationsRange.mockReset();
  client.cloudbedsGetReservationsPage.mockReset();
  client.cloudbedsGetReservationDetail.mockReset();
  activeList();
  canceledList();
});

describe("runCloudbedsSyncForHotel cancellation reconcile", () => {
  it("upserts a booking's nights, then removes them once it cancels", async () => {
    const supabase = makeSupabaseStub();

    // Run 1: confirmed, three nights on the books.
    activeList("R1");
    client.cloudbedsGetReservationDetail.mockResolvedValue(detailFor("R1", "R1-1", "confirmed"));
    const first = await runCloudbedsSyncForHotel(supabase, "hotel-1");
    expect(first.ok).toBe(true);
    expect(supabase.reservations).toHaveLength(3);

    // Run 2: guest cancels. The booking is gone from the active list and only
    // shows up under the canceled status filter.
    activeList();
    canceledList("R1");
    client.cloudbedsGetReservationDetail.mockResolvedValue(detailFor("R1", "R1-1", "canceled"));
    const second = await runCloudbedsSyncForHotel(supabase, "hotel-1");

    expect(second.ok).toBe(true);
    expect(supabase.reservations).toEqual([]);
    if (second.ok) {
      expect(second.ingest.canceledReservationsSeen).toBe(1);
      expect(second.ingest.canceledRowIdsDeleted).toBe(2);
    }
  });

  it("drops a booking the active list still lists but the detail reports canceled", async () => {
    const supabase = makeSupabaseStub([
      { external_reservation_id: "R2-1", stay_date: "2026-08-15", current_rate: 200 },
      { external_reservation_id: "R2-1", stay_date: "2026-08-16", current_rate: 200 },
    ]);

    activeList("R2");
    client.cloudbedsGetReservationDetail.mockResolvedValue(detailFor("R2", "R2-1", "no_show"));
    const res = await runCloudbedsSyncForHotel(supabase, "hotel-1");

    expect(res.ok).toBe(true);
    expect(supabase.reservations).toEqual([]);
    if (res.ok) expect(res.reservationRowsUpserted).toBe(0);
  });

  it("clears a canceled booking whose detail call fails, by its own id", async () => {
    const supabase = makeSupabaseStub([
      { external_reservation_id: "R4", stay_date: "2026-08-15", current_rate: 200 },
    ]);

    canceledList("R4");
    client.cloudbedsGetReservationDetail.mockResolvedValue(null);
    const res = await runCloudbedsSyncForHotel(supabase, "hotel-1");

    expect(res.ok).toBe(true);
    expect(supabase.reservations).toEqual([]);
    if (res.ok) expect(res.ingest.canceledDetailFailed).toBe(1);
  });

  it("clears rooms keyed by slot when the payload names no room ids", async () => {
    // Both parsers key an anonymous room slot `<reservationID>-<slot>`.
    const supabase = makeSupabaseStub([
      { external_reservation_id: "R9-1", stay_date: "2026-08-15", current_rate: 200 },
      { external_reservation_id: "R9-2", stay_date: "2026-08-15", current_rate: 200 },
    ]);

    canceledList("R9");
    client.cloudbedsGetReservationDetail.mockResolvedValue({
      reservationID: "R9",
      status: "canceled",
      assigned: [{ roomTypeID: "RT1" }, { roomTypeID: "RT1" }],
    });
    const res = await runCloudbedsSyncForHotel(supabase, "hotel-1");

    expect(res.ok).toBe(true);
    expect(supabase.reservations).toEqual([]);
  });

  it("clears a declared-count booking with no room array at all", async () => {
    const supabase = makeSupabaseStub([
      { external_reservation_id: "R10-2", stay_date: "2026-08-15", current_rate: 200 },
    ]);

    canceledList("R10");
    client.cloudbedsGetReservationDetail.mockResolvedValue({
      reservationID: "R10",
      status: "canceled",
      roomsQuantity: 2,
    });
    const res = await runCloudbedsSyncForHotel(supabase, "hotel-1");

    expect(res.ok).toBe(true);
    expect(supabase.reservations).toEqual([]);
  });

  it("survives a canceled status the account rejects", async () => {
    // The trigger used to be the British "cancelled", which lived in the status
    // list as a defensive second spelling until the live API was checked and it
    // turned out to be rejected every time. The resilience it exercised still
    // matters — an account that refuses one status must not take the whole sync
    // down — so the test now rejects a status that IS in the list.
    const supabase = makeSupabaseStub();
    client.cloudbedsGetReservationsPage.mockImplementation(
      async (_creds: unknown, _from: string, _to: string, status: string) => {
        if (status === "no_show") {
          throw new client.CloudbedsHttpError(
            "Cloudbeds getReservations failed (400): invalid status",
            400,
            "getReservations",
          );
        }
        return {
          reservations: status === "canceled" ? [{ reservationID: "R5" }] : [],
          hasMore: false,
        };
      },
    );
    client.cloudbedsGetReservationDetail.mockResolvedValue(detailFor("R5", "R5-1", "canceled"));

    const res = await runCloudbedsSyncForHotel(supabase, "hotel-1");

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.ingest.canceledStatusListFailures).toBe(1);
      expect(res.ingest.canceledReservationsSeen).toBe(1);
    }
  });

  it("leaves rows for reservations outside the fetched window alone", async () => {
    // Checked in long before checkInFrom, so neither list mentions it.
    const supabase = makeSupabaseStub([
      { external_reservation_id: "OLD-1", stay_date: "2024-03-02", current_rate: 120 },
    ]);

    activeList("R6");
    client.cloudbedsGetReservationDetail.mockResolvedValue(detailFor("R6", "R6-1", "confirmed"));
    const res = await runCloudbedsSyncForHotel(supabase, "hotel-1");

    expect(res.ok).toBe(true);
    expect(supabase.reservations.filter((r) => r.external_reservation_id === "OLD-1")).toHaveLength(
      1,
    );
  });

  it("leaves another booking's rows alone when a cancellation reuses its room", async () => {
    // roomID names a PHYSICAL room, which Cloudbeds hands to every booking that
    // ever occupies it. Keyed on that, cancelling one booking deleted the rows of
    // whoever else stayed in room 101 — and an out-of-window victim like this one
    // is in neither list, so no upsert in this run puts it back.
    const supabase = makeSupabaseStub([
      { external_reservation_id: "101", stay_date: "2026-06-01", current_rate: 180 },
    ]);

    canceledList("RES-NEW");
    client.cloudbedsGetReservationDetail.mockResolvedValue({
      reservationID: "RES-NEW",
      status: "canceled",
      assigned: [{ roomID: "101", roomTypeID: "RT1" }],
    });
    const res = await runCloudbedsSyncForHotel(supabase, "hotel-1");

    expect(res.ok).toBe(true);
    expect(supabase.reservations.map((r) => r.external_reservation_id)).toEqual(["101"]);
  });

  it("clears every room of a large group, not just the first 64", async () => {
    const subIds = Array.from({ length: 70 }, (_, i) => `GRP-${i + 1}`);
    const supabase = makeSupabaseStub(
      subIds.map((id) => ({
        external_reservation_id: id,
        stay_date: "2026-08-15",
        current_rate: 200,
      })),
    );

    canceledList("GRP");
    client.cloudbedsGetReservationDetail.mockResolvedValue({
      reservationID: "GRP",
      status: "canceled",
      assigned: subIds.map((id) => ({ subReservationID: id, roomTypeID: "RT1" })),
    });
    const res = await runCloudbedsSyncForHotel(supabase, "hotel-1");

    expect(res.ok).toBe(true);
    // The slot cap exists to bound a fabricated room count; applied to real ids it
    // stranded rooms 65+ permanently, since nothing revisits a canceled booking.
    expect(supabase.reservations).toEqual([]);
  });

  it("fails the sync when the canceled list is refused for anything but a bad status", async () => {
    const supabase = makeSupabaseStub([
      { external_reservation_id: "R11-1", stay_date: "2026-08-15", current_rate: 200 },
    ]);
    client.cloudbedsGetReservationsPage.mockRejectedValue(
      new client.CloudbedsHttpError(
        "Cloudbeds getReservations failed (401): token revoked",
        401,
        "getReservations",
      ),
    );

    const res = await runCloudbedsSyncForHotel(supabase, "hotel-1");

    // Swallowed, this reported a connected hotel and a healthy sync that had in
    // fact reconciled no cancellations at all.
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.cloudbedsStatus).toBe(401);
    expect(supabase.reservations).toHaveLength(1);
  });

  it("still writes the run's active room-nights when the canceled list is refused", async () => {
    const supabase = makeSupabaseStub();
    activeList("R1");
    client.cloudbedsGetReservationDetail.mockResolvedValue(detailFor("R1", "R1-1", "confirmed"));
    client.cloudbedsGetReservationsPage.mockRejectedValue(
      new client.CloudbedsHttpError("Cloudbeds getReservations failed (503)", 503, "getReservations"),
    );

    const res = await runCloudbedsSyncForHotel(supabase, "hotel-1");

    // Reporting the failure is right. Discarding the reservations we already
    // parsed is not: fetched before the upsert, one 503 on the cancellation
    // list cost every hotel a whole cron cycle of data and its rate push.
    expect(res.ok).toBe(false);
    expect(supabase.reservations).toHaveLength(3);
  });

  it("prunes nights a still-active booking no longer holds, and only those", async () => {
    // The stay moved from the 14th to 15th–17th; another booking shares one of
    // the old dates and must not be caught by the grouped delete.
    const supabase = makeSupabaseStub([
      { external_reservation_id: "R1-1", stay_date: "2026-08-14", current_rate: 200 },
      { external_reservation_id: "OTHER-1", stay_date: "2026-08-14", current_rate: 150 },
    ]);

    activeList("R1");
    client.cloudbedsGetReservationDetail.mockResolvedValue(detailFor("R1", "R1-1", "confirmed"));
    const res = await runCloudbedsSyncForHotel(supabase, "hotel-1");

    expect(res.ok).toBe(true);
    const r1Dates = supabase.reservations
      .filter((r) => r.external_reservation_id === "R1-1")
      .map((r) => r.stay_date)
      .sort();
    expect(r1Dates).toEqual(["2026-08-15", "2026-08-16", "2026-08-17"]);
    expect(
      supabase.reservations.filter((r) => r.external_reservation_id === "OTHER-1"),
    ).toHaveLength(1);
  });

  it("does not reactivate a room type on the room_types upsert", async () => {
    const supabase = makeSupabaseStub();

    const res = await runCloudbedsSyncForHotel(supabase, "hotel-1");

    expect(res.ok).toBe(true);
    // is_active in the payload lands in PostgREST's DO UPDATE SET, so a type the
    // owner excluded came back active within five minutes and got priced.
    expect(supabase.roomTypeUpserts).toHaveLength(1);
    expect(supabase.roomTypeUpserts[0]).not.toHaveProperty("is_active");
  });
});

describe("re-syncing unchanged data writes nothing", () => {
  it("skips every row whose stored copy already matches", async () => {
    const supabase = makeSupabaseStub();
    activeList("R1");
    client.cloudbedsGetReservationDetail.mockResolvedValue(detailFor("R1", "R1-1", "confirmed"));

    const first = await runCloudbedsSyncForHotel(supabase, "hotel-1");
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.reservationRowsUpserted).toBe(3);
      expect(first.ingest.unchangedRowsSkipped).toBe(0);
    }

    // Same book, next tick: the data moved nowhere, so neither should a write.
    const second = await runCloudbedsSyncForHotel(supabase, "hotel-1");
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.reservationRowsUpserted).toBe(0);
      expect(second.ingest.unchangedRowsSkipped).toBe(3);
    }
    expect(supabase.reservations).toHaveLength(3);
  });
});

describe("a full sweep bigger than one budget resumes across ticks", () => {
  const T0 = new Date("2026-08-04T10:00:00Z");

  // Each detail call burns a minute of fake clock, so the 210s budget truncates
  // the sweep after the fourth attempt.
  function slowDetails() {
    client.cloudbedsGetReservationDetail.mockImplementation(async (_c: unknown, rid: string) => {
      vi.advanceTimersByTime(60_000);
      return detailFor(rid, `${rid}-1`, "confirmed");
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("checkpoints where it stopped instead of forgetting everything", async () => {
    const supabase = makeSupabaseStub();
    // Deliberately shuffled: the cursor only means something if every tick
    // walks the same order regardless of what the API returned first.
    activeList("r3", "r1", "r6", "r2", "r5", "r4");
    slowDetails();

    const res = await runCloudbedsSyncForHotel(supabase, "hotel-1");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.windowFullyCovered).toBe(false);

    // Sorted order r1..r6, budget out after r4.
    const fetched = client.cloudbedsGetReservationDetail.mock.calls.map((c) => c[1]);
    expect(fetched).toEqual(["r1", "r2", "r3", "r4"]);

    const stamp = supabase.connUpdates.at(-1)!;
    expect(stamp.full_sweep_after_id).toBe("r4");
    expect(stamp.full_sweep_started_at).toBe(T0.toISOString());
    // The window was not covered: neither watermark may move.
    expect(stamp).not.toHaveProperty("reservations_modified_through");
    expect(stamp).not.toHaveProperty("last_full_sync_at");

    // A mid-flight chunk spends nothing on the cancellation pass.
    expect(client.cloudbedsGetReservationsPage).not.toHaveBeenCalled();
  });

  it("resumes past the cursor and stamps the watermark from the sweep's start", async () => {
    const sweepStart = "2026-08-04T09:45:00.000Z";
    const supabase = makeSupabaseStub([], {
      full_sweep_after_id: "r4",
      full_sweep_started_at: sweepStart,
    });
    activeList("r3", "r1", "r6", "r2", "r5", "r4");
    client.cloudbedsGetReservationDetail.mockImplementation(async (_c: unknown, rid: string) =>
      detailFor(rid, `${rid}-1`, "confirmed"),
    );

    const res = await runCloudbedsSyncForHotel(supabase, "hotel-1");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.windowFullyCovered).toBe(true);

    // Only the tail the earlier ticks never reached.
    const fetched = client.cloudbedsGetReservationDetail.mock.calls.map((c) => c[1]);
    expect(fetched).toEqual(["r5", "r6"]);

    const stamp = supabase.connUpdates.at(-1)!;
    // Modified-while-sweeping must fall inside the next incremental pull, so
    // the watermark is the sweep's beginning — not this final chunk's start.
    expect(stamp.reservations_modified_through).toBe(sweepStart);
    expect(stamp.last_full_sync_at).toBe(sweepStart);
    expect(stamp.full_sweep_after_id).toBeNull();
    expect(stamp.full_sweep_started_at).toBeNull();
  });

  it("an explicit window never checkpoints — it is a one-shot re-read", async () => {
    const supabase = makeSupabaseStub();
    activeList("r1", "r2", "r3", "r4", "r5", "r6");
    slowDetails();

    const res = await runCloudbedsSyncForHotel(supabase, "hotel-1", { daysBack: 5 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.windowFullyCovered).toBe(false);

    const stamp = supabase.connUpdates.at(-1)!;
    expect(stamp).not.toHaveProperty("full_sweep_after_id");
    expect(stamp).not.toHaveProperty("full_sweep_started_at");
  });
});

/** Serve each status's reservations only when the sync actually asks for that status. */
function activeByStatus(byStatus: Record<string, string[]>) {
  client.cloudbedsGetReservationsRange.mockImplementation(
    async (_creds: unknown, _from: string, _to: string, statuses: readonly string[]) => ({
      reservations: statuses.flatMap((s) => (byStatus[s] ?? []).map((id) => ({ reservationID: id }))),
      pages: statuses.length,
    }),
  );
}

describe("a booking awaiting confirmation", () => {
  const NIGHTS = ["2026-08-15", "2026-08-16", "2026-08-17"];

  /** The engine's own numerator: snapshot the stored nights, then read occupancy. */
  async function occupancyOn(
    db: ReturnType<typeof fakeSupabase>,
    snapshotTs: string,
  ): Promise<(number | null)[]> {
    const roomTypes = db.tables.room_types as unknown as RoomTypeRow[];
    await snapshotCurrentState(db.client, "hotel-1", snapshotTs, NIGHTS, roomTypes);
    return NIGHTS.map((night) => {
      const snaps = db.tables.stay_date_snapshot.filter(
        (s) => s.snapshot_ts === snapshotTs && s.stay_date === night,
      );
      const byType = new Map(
        snaps.map((s) => [
          String(s.room_type_id),
          { booked_units: Number(s.booked_units), sellable_units: Number(s.sellable_units) },
        ]),
      );
      return computeOccupancy(byType, roomTypes.map((rt) => rt.id));
    });
  }

  function hotelDb() {
    return fakeSupabase({
      hotels: [{ id: "hotel-1", total_rooms_per_type: 10 }],
      pms_connections: [
        { id: "conn-1", hotel_id: "hotel-1", pms_type: "cloudbeds", status: "connected", base_url: null },
      ],
    });
  }

  it("is stored and counts as sold, then leaves occupancy when it cancels", async () => {
    const db = hotelDb();

    // Cloudbeds counts Confirmation Pending as sold in its own occupancy.
    activeByStatus({ not_confirmed: ["R1"] });
    client.cloudbedsGetReservationDetail.mockResolvedValue(detailFor("R1", "R1-1", "not_confirmed"));
    const first = await runCloudbedsSyncForHotel(db.client, "hotel-1");

    expect(first.ok).toBe(true);
    expect(db.tables.reservations.map((r) => r.stay_date).sort()).toEqual(NIGHTS);
    // 1 of the King type's 10 rooms, every night of the stay.
    expect(await occupancyOn(db, "2026-08-01T00:00:00.000Z")).toEqual([0.1, 0.1, 0.1]);

    // The guest never confirms and the booking is canceled: gone from every
    // active list, present only under the canceled filter.
    activeByStatus({});
    canceledList("R1");
    client.cloudbedsGetReservationDetail.mockResolvedValue(detailFor("R1", "R1-1", "canceled"));
    const second = await runCloudbedsSyncForHotel(db.client, "hotel-1");

    expect(second.ok).toBe(true);
    expect(db.tables.reservations).toEqual([]);
    expect(await occupancyOn(db, "2026-08-01T00:05:00.000Z")).toEqual([0, 0, 0]);
  });

  it("keeps one set of nights when it confirms, updated in place", async () => {
    const db = hotelDb();

    activeByStatus({ not_confirmed: ["R1"] });
    client.cloudbedsGetReservationDetail.mockResolvedValue(detailFor("R1", "R1-1", "not_confirmed"));
    expect((await runCloudbedsSyncForHotel(db.client, "hotel-1")).ok).toBe(true);
    expect(db.tables.reservations.map((r) => r.current_rate)).toEqual([200, 200, 200]);

    // Confirmed at a different rate: same booking, same room keys, so the
    // nights must be overwritten rather than stored a second time.
    const confirmed = detailFor("R1", "R1-1", "confirmed");
    for (const night of confirmed.assigned[0].dailyRates) night.rate = 240;
    activeByStatus({ confirmed: ["R1"] });
    client.cloudbedsGetReservationDetail.mockResolvedValue(confirmed);
    expect((await runCloudbedsSyncForHotel(db.client, "hotel-1")).ok).toBe(true);

    expect(db.tables.reservations).toHaveLength(3);
    expect(db.tables.reservations.map((r) => r.current_rate)).toEqual([240, 240, 240]);
  });

  it("is asked for on incremental pulls too, under the same watermark", async () => {
    const supabase = makeSupabaseStub([], {
      reservations_modified_through: new Date(Date.now() - 10 * 60_000).toISOString(),
      last_full_sync_at: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    activeByStatus({ not_confirmed: ["R7"] });
    client.cloudbedsGetReservationDetail.mockResolvedValue(detailFor("R7", "R7-1", "not_confirmed"));

    const res = await runCloudbedsSyncForHotel(supabase, "hotel-1");

    expect(res.ok).toBe(true);
    const [, , , statuses, modifiedFrom] = client.cloudbedsGetReservationsRange.mock.calls.at(-1)!;
    expect(statuses).toContain("not_confirmed");
    expect(modifiedFrom).toEqual(expect.any(String));
    expect(supabase.reservations).toHaveLength(3);
  });
});

describe("the connection status a sync leaves behind", () => {
  function syncOnce(status: string) {
    const supabase = makeSupabaseStub([], { status });
    activeList("R1");
    client.cloudbedsGetReservationDetail.mockResolvedValue(detailFor("R1", "R1-1", "confirmed"));
    return { supabase, run: runCloudbedsSyncForHotel(supabase, "hotel-1") };
  }

  it("leaves a pending connection pending, and still advances its watermark", async () => {
    const { supabase, run } = syncOnce("pending");
    expect((await run).ok).toBe(true);

    // Pending is a property nobody has paid for. The import worker runs this
    // same sync, so promoting it here put unpaid properties in the scheduler.
    expect(supabase.connection.status).toBe("pending");
    expect(supabase.connection.last_sync_at).toEqual(expect.any(String));
    expect(supabase.connection.reservations_modified_through).toEqual(expect.any(String));
  });

  it("clears degraded after a healthy run", async () => {
    const { supabase, run } = syncOnce("degraded");
    expect((await run).ok).toBe(true);
    expect(supabase.connection.status).toBe("connected");
  });

  it("clears error after a healthy run", async () => {
    const { supabase, run } = syncOnce("error");
    expect((await run).ok).toBe(true);
    expect(supabase.connection.status).toBe("connected");
  });

  it("never resurrects a disconnected connection", async () => {
    const { supabase, run } = syncOnce("disconnected");
    expect((await run).ok).toBe(true);
    expect(supabase.connection.status).toBe("disconnected");
    expect(supabase.connection.last_sync_at).toEqual(expect.any(String));
  });

  it("puts the condition in the write itself, so a status that changed mid-run wins", async () => {
    // Degraded when the run began, disconnected by the time the stamp goes
    // out. Deciding from a read at the start would write 'connected' over it.
    const db = fakeSupabase({
      hotels: [{ id: "hotel-1", total_rooms_per_type: 10 }],
      pms_connections: [
        { id: "conn-1", hotel_id: "hotel-1", pms_type: "cloudbeds", status: "degraded", base_url: null },
      ],
    });
    activeList("R1");
    client.cloudbedsGetReservationDetail.mockImplementation(async () => {
      db.tables.pms_connections[0].status = "disconnected";
      return detailFor("R1", "R1-1", "confirmed");
    });

    expect((await runCloudbedsSyncForHotel(db.client, "hotel-1")).ok).toBe(true);

    expect(db.tables.pms_connections[0].status).toBe("disconnected");
    const statusWrites = db.calls.filter(
      (c) => c.table === "pms_connections" && c.op === "update" && c.filters.some((f) => f.col === "status"),
    );
    expect(statusWrites).toHaveLength(1);
    expect(statusWrites[0].filters).toContainEqual({
      col: "status",
      kind: "in",
      value: ["connected", "degraded", "error"],
    });
  });
});
