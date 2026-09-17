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
    cloudbedsGetReservationsWithRateDetailsPage: vi.fn(),
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
type Json = Record<string, unknown>;

/**
 * "Now" for every test. The sync window is 30 days back and 396 forward from
 * it, so check-ins from 2026-07-05 to 2027-09-04 are inside.
 */
const NOW = new Date("2026-08-04T10:00:00Z");
const WINDOW_START = "2026-07-05";

/**
 * In-memory `reservations` table. The point of these tests is which rows
 * survive a sync, so deletes actually have to filter rather than be recorded.
 * Writes run the reservations_sync_base_rate trigger's rule: base_rate is
 * filled from current_rate on insert and never changes afterwards.
 */
function makeSupabaseStub(seed: ResRow[] = [], syncState: ResRow = {}) {
  const reservations: ResRow[] = seed.map((r) => ({
    hotel_id: "hotel-1",
    base_rate: r.base_rate ?? r.current_rate ?? null,
    ...r,
  }));
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
      is: () => builder,
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
        if (name === "pms_connections") return { data: { ...connection, base_url: null } };
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
          if (idx >= 0) {
            const old = reservations[idx];
            reservations[idx] = { ...old, ...row, base_rate: old.base_rate ?? row.base_rate ?? row.current_rate ?? null };
          } else {
            reservations.push({ ...row, base_rate: row.base_rate ?? row.current_rate ?? null });
          }
        }
        return { error: null };
      },
      delete: deleteBuilder,
    };
    if (name === "room_types") {
      return {
        ...chain,
        select: () => ({
          eq: async () => ({
            data: [
              { id: "rt-uuid-1", external_room_type_id: "RT1" },
              { id: "rt-uuid-2", external_room_type_id: "RT2" },
            ],
          }),
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

/* ── Rate-details fixtures, shaped like the sandbox payload ─────────────── */

type RoomFixture = {
  sub: string;
  roomTypeID?: string;
  /** {date: amount}, one entry per night this room holds. */
  rates: Record<string, number | null>;
  roomID?: string | null;
};

const PLACEHOLDER_GUEST = "Guest Placeholder";

function nightsBetween(checkIn: string, checkOut: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${checkIn}T00:00:00Z`); d.toISOString().slice(0, 10) < checkOut; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * One getReservationsWithRateDetails booking. Keys and value types match what
 * the sandbox returned on 2026-09-16; every value is invented, and the guest
 * fields carry a placeholder so redaction has something to drop.
 */
function booking(opts: {
  id: string;
  status: string;
  checkIn: string;
  checkOut: string;
  rooms?: RoomFixture[];
  /** Same nightly rate on every night of one room, when `rooms` is omitted. */
  nightly?: number;
  created?: string;
  modified?: string;
}): Json {
  const rooms: RoomFixture[] =
    opts.rooms ??
    [{
      sub: opts.id,
      rates: Object.fromEntries(nightsBetween(opts.checkIn, opts.checkOut).map((n) => [n, opts.nightly ?? 200])),
    }];
  const detailedRates: Record<string, number> = {};
  for (const room of rooms) {
    for (const [date, amount] of Object.entries(room.rates)) {
      detailedRates[date] = (detailedRates[date] ?? 0) + (amount ?? 0);
    }
  }
  const total = Object.values(detailedRates).reduce((s, n) => s + n, 0);
  const created = `${opts.created ?? "2026-07-01"} 09:30:00`;
  const modified = opts.modified ?? created;
  const canceled = opts.status === "canceled" || opts.status === "no_show";
  return {
    reservationID: opts.id,
    isDeleted: false,
    dateCreated: created,
    dateCreatedUTC: created,
    dateModified: modified,
    dateModifiedUTC: modified,
    status: opts.status,
    reservationCheckIn: opts.checkIn,
    reservationCheckOut: opts.checkOut,
    guestID: "900000001",
    profileID: "900000002",
    guestName: PLACEHOLDER_GUEST,
    guestCountry: "XX",
    propertyID: "prop-1",
    thirdPartyIdentifier: "",
    estimatedArrivalTime: null,
    total,
    balance: total,
    dateImported: null,
    sourceName: "Website/Booking Engine",
    source: { name: "Website/Booking Engine", paymentCollect: "hotel", sourceID: "s-1" },
    propertyCurrency: "USD",
    balanceDetailed: { suggestedDeposit: 0, subTotal: total, taxesFees: 0, additionalItems: 0, grandTotal: total, paid: 0 },
    allotmentBlockCode: null,
    origin: "",
    detailedRates,
    rooms: rooms.map((room) => ({
      roomTypeID: room.roomTypeID ?? "RT1",
      roomTypeIsVirtual: false,
      roomTypeName: room.roomTypeID === "RT2" ? "Queen" : "King",
      subReservationID: room.sub,
      isRoomLocked: false,
      guestID: "900000001",
      guestName: PLACEHOLDER_GUEST,
      rateID: "700001",
      rateName: "Standard",
      adults: "2",
      children: "0",
      roomID: room.roomID ?? null,
      roomCheckIn: opts.checkIn,
      roomCheckOut: opts.checkOut,
      roomStatus: "not_checked_in",
      detailedRoomRates: room.rates,
      detailedRoomRateNames: [],
      ratePlanNamePrivate: null,
      ratePlanNamePublic: null,
      marketName: "Direct",
      marketCode: "direct",
      roomName: room.roomID ? `Room ${room.roomID}` : null,
    })),
    guestList: {},
    mealPlans: "",
    ...(canceled ? { dateCancelled: modified, dateCancelledUTC: modified } : {}),
  };
}

/** Three nights at 200 in one King, checking in 2026-08-15. */
function stay(id: string, status = "confirmed", extra: Partial<Parameters<typeof booking>[0]> = {}) {
  return booking({ id, status, checkIn: "2026-08-15", checkOut: "2026-08-18", ...extra });
}

type RateDetailsQuery = { checkOutFrom: string; checkOutTo?: string; modifiedFrom?: string };

/**
 * The server as the sandbox showed it behaves: filters by check-out and
 * modifiedFrom, ignores status, pages at 100 with a total.
 */
function serve(book: Json[], opts: { orderSeed?: number; onCall?: (q: RateDetailsQuery, page: number) => void } = {}) {
  client.cloudbedsGetReservationsWithRateDetailsPage.mockImplementation(
    async (_creds: unknown, query: RateDetailsQuery, pageNumber: number) => {
      opts.onCall?.(query, pageNumber);
      let matched = book.filter(
        (b) =>
          String(b.reservationCheckOut) >= query.checkOutFrom &&
          (query.checkOutTo === undefined || String(b.reservationCheckOut) <= query.checkOutTo) &&
          (query.modifiedFrom === undefined || String(b.dateModified) >= query.modifiedFrom),
      );
      if (opts.orderSeed != null) {
        const seed = opts.orderSeed;
        matched = [...matched].sort((a, b) =>
          ((Number(String(a.reservationID).replace(/\D/g, "")) * (seed + 7)) % 997) -
          ((Number(String(b.reservationID).replace(/\D/g, "")) * (seed + 7)) % 997),
        );
      }
      const start = (pageNumber - 1) * 100;
      return {
        reservations: matched.slice(start, start + 100),
        hasMore: start + 100 < matched.length,
        total: matched.length,
      };
    },
  );
}

const rateDetailsQueries = () =>
  client.cloudbedsGetReservationsWithRateDetailsPage.mock.calls.map((c) => c[1] as RateDetailsQuery);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  client.cloudbedsGetReservationsWithRateDetailsPage.mockReset();
  client.cloudbedsGetReservationsRange.mockReset();
  client.cloudbedsGetReservationsPage.mockReset();
  client.cloudbedsGetReservationDetail.mockReset();
  client.cloudbedsGetTaxesAndFees.mockClear();
  serve([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("reading the window from rate details", () => {
  it("stores a single-room booking night by night at its own rates, with guest fields dropped", async () => {
    const supabase = makeSupabaseStub();
    serve([
      booking({
        id: "5001",
        status: "confirmed",
        checkIn: "2026-08-15",
        checkOut: "2026-08-18",
        rooms: [{ sub: "5001", rates: { "2026-08-15": 180, "2026-08-16": 210, "2026-08-17": 240 }, roomID: "101" }],
      }),
    ]);

    const res = await runCloudbedsSyncForHotel(supabase, "hotel-1");

    expect(res.ok).toBe(true);
    const rows = [...supabase.reservations].sort((a, b) => String(a.stay_date).localeCompare(String(b.stay_date)));
    expect(rows.map((r) => [r.external_reservation_id, r.stay_date, r.current_rate, r.room_type_id])).toEqual([
      ["5001-1", "2026-08-15", 180, "rt-uuid-1"],
      ["5001-1", "2026-08-16", 210, "rt-uuid-1"],
      ["5001-1", "2026-08-17", 240, "rt-uuid-1"],
    ]);
    const payload = rows[0].raw_payload as Json;
    expect(JSON.stringify(payload)).not.toContain(PLACEHOLDER_GUEST);
    expect(payload).not.toHaveProperty("guestID");
    expect(payload).toMatchObject({ startDate: "2026-08-15", endDate: "2026-08-18", roomTypeID: "RT1", _redacted: true });
    // One page, and none of the per-booking calls it replaced.
    expect(client.cloudbedsGetReservationsWithRateDetailsPage).toHaveBeenCalledTimes(1);
    expect(client.cloudbedsGetReservationDetail).not.toHaveBeenCalled();
    expect(client.cloudbedsGetReservationsRange).not.toHaveBeenCalled();
    expect(client.cloudbedsGetReservationsPage).not.toHaveBeenCalled();
    if (res.ok) {
      expect(res.ingest.source).toBe("rate_details");
      expect(res.windowFullyCovered).toBe(true);
      expect(res.windowRows).toBe(3);
      expect(res.stayDates).toEqual({ oldest: "2026-08-15", newest: "2026-08-17" });
    }
  });

  it("gives every room of a multi-room booking its own nights at its own rate, never the booking sum", async () => {
    const supabase = makeSupabaseStub();
    serve([
      booking({
        id: "6001",
        status: "confirmed",
        checkIn: "2026-09-01",
        checkOut: "2026-09-03",
        rooms: [
          // Cloudbeds gives the first room the booking's own id and the rest <id>-<n>.
          { sub: "6001", roomTypeID: "RT1", rates: { "2026-09-01": 300, "2026-09-02": 320 } },
          { sub: "6001-2", roomTypeID: "RT2", rates: { "2026-09-01": 150, "2026-09-02": 150 } },
          { sub: "6001-3", roomTypeID: "RT2", rates: { "2026-09-01": 155, "2026-09-02": 165 } },
        ],
      }),
    ]);

    const res = await runCloudbedsSyncForHotel(supabase, "hotel-1");

    expect(res.ok).toBe(true);
    const got = Object.fromEntries(
      supabase.reservations.map((r) => [`${r.external_reservation_id}:${r.stay_date}`, [r.current_rate, r.room_type_id]]),
    );
    expect(got).toEqual({
      "6001-1:2026-09-01": [300, "rt-uuid-1"],
      "6001-1:2026-09-02": [320, "rt-uuid-1"],
      "6001-2:2026-09-01": [150, "rt-uuid-2"],
      "6001-2:2026-09-02": [150, "rt-uuid-2"],
      "6001-3:2026-09-01": [155, "rt-uuid-2"],
      "6001-3:2026-09-02": [165, "rt-uuid-2"],
    });
    // The booking-level detailedRates for the 1st is 605: no room may carry it.
    expect(supabase.reservations.some((r) => r.current_rate === 605)).toBe(false);
  });

  it("writes true per-night rates on the first insert, so base_rate never freezes an approximation", async () => {
    const supabase = makeSupabaseStub();
    // Two rooms, two nights, $1,000 in total. The list-only estimate would be
    // 1000 / (2 nights x 2 rooms) = 250 on every row.
    serve([
      booking({
        id: "7001",
        status: "confirmed",
        checkIn: "2026-10-10",
        checkOut: "2026-10-12",
        rooms: [
          { sub: "7001", rates: { "2026-10-10": 400, "2026-10-11": 300 } },
          { sub: "7001-2", rates: { "2026-10-10": 160, "2026-10-11": 140 } },
        ],
      }),
    ]);
    expect((await runCloudbedsSyncForHotel(supabase, "hotel-1")).ok).toBe(true);

    const baseByKey = () =>
      Object.fromEntries(supabase.reservations.map((r) => [`${r.external_reservation_id}:${r.stay_date}`, r.base_rate]));
    expect(baseByKey()).toEqual({
      "7001-1:2026-10-10": 400,
      "7001-1:2026-10-11": 300,
      "7001-2:2026-10-10": 160,
      "7001-2:2026-10-11": 140,
    });

    // A later re-price moves current_rate; base_rate keeps the first true rate.
    serve([
      booking({
        id: "7001",
        status: "confirmed",
        checkIn: "2026-10-10",
        checkOut: "2026-10-12",
        rooms: [
          { sub: "7001", rates: { "2026-10-10": 450, "2026-10-11": 300 } },
          { sub: "7001-2", rates: { "2026-10-10": 160, "2026-10-11": 140 } },
        ],
      }),
    ]);
    expect((await runCloudbedsSyncForHotel(supabase, "hotel-1", { daysBack: 30 })).ok).toBe(true);
    const repriced = supabase.reservations.find((r) => r.external_reservation_id === "7001-1" && r.stay_date === "2026-10-10")!;
    expect(repriced.current_rate).toBe(450);
    expect(repriced.base_rate).toBe(400);
  });

  it("keeps a night whose amount is missing as an unknown rate, not a $0 comp", async () => {
    const supabase = makeSupabaseStub();
    serve([
      booking({
        id: "7101",
        status: "confirmed",
        checkIn: "2026-08-20",
        checkOut: "2026-08-22",
        rooms: [{ sub: "7101", rates: { "2026-08-20": 190, "2026-08-21": null } }],
      }),
    ]);

    const res = await runCloudbedsSyncForHotel(supabase, "hotel-1");

    expect(res.ok).toBe(true);
    const byNight = Object.fromEntries(supabase.reservations.map((r) => [r.stay_date, r.current_rate]));
    expect(byNight).toEqual({ "2026-08-20": 190, "2026-08-21": null });
  });

  it("filters by check-out on the server and by check-in here, asking for no status at all", async () => {
    const supabase = makeSupabaseStub();
    serve([
      stay("8001"),
      // Arrived before the window and still in the house when it starts.
      booking({ id: "8002", status: "checked_in", checkIn: "2026-06-20", checkOut: "2026-07-08" }),
      // Arrives after the window's last check-in day.
      booking({ id: "8003", status: "confirmed", checkIn: "2027-09-10", checkOut: "2027-09-12" }),
      // Checked out before the window: the server never returns it.
      booking({ id: "8004", status: "checked_out", checkIn: "2026-06-01", checkOut: "2026-06-03" }),
    ]);

    const res = await runCloudbedsSyncForHotel(supabase, "hotel-1");

    expect(res.ok).toBe(true);
    expect(new Set(supabase.reservations.map((r) => r.external_reservation_id))).toEqual(new Set(["8001-1"]));
    if (res.ok) expect(res.ingest.bookingsOutsideWindow).toBe(2);
    const [query] = rateDetailsQueries();
    expect(query).toEqual({ checkOutFrom: WINDOW_START, checkOutTo: undefined, modifiedFrom: undefined });
    expect(query).not.toHaveProperty("status");
  });

  it("removes a booking's nights once it cancels, from the same pages and with no extra calls", async () => {
    const supabase = makeSupabaseStub();
    serve([stay("9001")]);
    expect((await runCloudbedsSyncForHotel(supabase, "hotel-1")).ok).toBe(true);
    expect(supabase.reservations).toHaveLength(3);

    client.cloudbedsGetReservationsWithRateDetailsPage.mockClear();
    serve([stay("9001", "canceled", { modified: "2026-08-03 12:00:00" })]);
    const second = await runCloudbedsSyncForHotel(supabase, "hotel-1", { daysBack: 30 });

    expect(second.ok).toBe(true);
    expect(supabase.reservations).toEqual([]);
    if (second.ok) {
      expect(second.ingest.canceledReservationsSeen).toBe(1);
      expect(second.apiPages).toBe(1);
    }
    expect(client.cloudbedsGetReservationsWithRateDetailsPage).toHaveBeenCalledTimes(1);
    expect(client.cloudbedsGetReservationDetail).not.toHaveBeenCalled();
    expect(client.cloudbedsGetReservationsPage).not.toHaveBeenCalled();
  });

  it("clears every room of a canceled group, including rooms past 64", async () => {
    const rooms: RoomFixture[] = Array.from({ length: 70 }, (_, i) => ({
      sub: i === 0 ? "GRP" : `GRP-${i + 1}`,
      rates: { "2026-08-15": 200 },
    }));
    const supabase = makeSupabaseStub(
      ["GRP-1", ...rooms.slice(1).map((r) => r.sub)].map((id) => ({
        external_reservation_id: id,
        stay_date: "2026-08-15",
        current_rate: 200,
      })),
    );
    serve([booking({ id: "GRP", status: "no_show", checkIn: "2026-08-15", checkOut: "2026-08-16", rooms })]);

    const res = await runCloudbedsSyncForHotel(supabase, "hotel-1");

    expect(res.ok).toBe(true);
    expect(supabase.reservations).toEqual([]);
  });

  it("leaves another booking's rows alone when a cancellation names the same physical room", async () => {
    // roomID names a PHYSICAL room, reused by every booking that ever occupies
    // it. Keyed on that, cancelling one booking deleted whoever else stayed in
    // room 101.
    const supabase = makeSupabaseStub([
      { external_reservation_id: "101", stay_date: "2026-06-01", current_rate: 180 },
    ]);
    serve([stay("RES-NEW", "canceled", { rooms: [{ sub: "RES-NEW", rates: {}, roomID: "101" }] })]);

    const res = await runCloudbedsSyncForHotel(supabase, "hotel-1");

    expect(res.ok).toBe(true);
    expect(supabase.reservations.map((r) => r.external_reservation_id)).toEqual(["101"]);
  });

  it("leaves rows for reservations outside the fetched window alone", async () => {
    const supabase = makeSupabaseStub([
      { external_reservation_id: "OLD-1", stay_date: "2024-03-02", current_rate: 120 },
    ]);
    serve([stay("R6")]);

    const res = await runCloudbedsSyncForHotel(supabase, "hotel-1");

    expect(res.ok).toBe(true);
    expect(supabase.reservations.filter((r) => r.external_reservation_id === "OLD-1")).toHaveLength(1);
  });

  it("leaves a booking in a status it does not recognise exactly as stored", async () => {
    const supabase = makeSupabaseStub([
      { external_reservation_id: "R12-1", stay_date: "2026-08-15", current_rate: 200 },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    serve([stay("R12", "some_new_status")]);

    const res = await runCloudbedsSyncForHotel(supabase, "hotel-1");

    expect(res.ok).toBe(true);
    expect(supabase.reservations).toHaveLength(1);
    if (res.ok) expect(res.ingest.bookingsWithUnknownStatus).toBe(1);
    warn.mockRestore();
  });

  it("prunes nights a still-active booking no longer holds, and only those", async () => {
    // The stay moved from the 14th to 15th–17th; another booking shares one of
    // the old dates and must not be caught by the grouped delete.
    const supabase = makeSupabaseStub([
      { external_reservation_id: "R1-1", stay_date: "2026-08-14", current_rate: 200 },
      { external_reservation_id: "OTHER-1", stay_date: "2026-08-14", current_rate: 150 },
    ]);
    serve([stay("R1")]);

    const res = await runCloudbedsSyncForHotel(supabase, "hotel-1");

    expect(res.ok).toBe(true);
    const r1Dates = supabase.reservations
      .filter((r) => r.external_reservation_id === "R1-1")
      .map((r) => r.stay_date)
      .sort();
    expect(r1Dates).toEqual(["2026-08-15", "2026-08-16", "2026-08-17"]);
    expect(supabase.reservations.filter((r) => r.external_reservation_id === "OTHER-1")).toHaveLength(1);
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

describe("incremental pulls", () => {
  it("asks only for what changed since the watermark and applies it, cancellations included", async () => {
    const watermark = new Date(NOW.getTime() - 10 * 60_000);
    const supabase = makeSupabaseStub(
      [
        { external_reservation_id: "C1-1", stay_date: "2026-08-20", current_rate: 210 },
        { external_reservation_id: "C1-1", stay_date: "2026-08-21", current_rate: 210 },
      ],
      {
        reservations_modified_through: watermark.toISOString(),
        last_full_sync_at: new Date(NOW.getTime() - 60 * 60_000).toISOString(),
      },
    );
    serve([
      // Untouched for weeks: an incremental pull never sees it.
      booking({ id: "U1", status: "confirmed", checkIn: "2026-08-25", checkOut: "2026-08-26", modified: "2026-07-01 08:00:00" }),
      booking({ id: "N1", status: "confirmed", checkIn: "2026-08-15", checkOut: "2026-08-17", modified: "2026-08-04 09:58:00" }),
      booking({ id: "C1", status: "canceled", checkIn: "2026-08-20", checkOut: "2026-08-22", modified: "2026-08-04 09:59:00" }),
    ]);

    const res = await runCloudbedsSyncForHotel(supabase, "hotel-1");

    expect(res.ok).toBe(true);
    const [query] = rateDetailsQueries();
    // Watermark minus the two-hour overlap, in Cloudbeds' own timestamp format.
    expect(query.modifiedFrom).toBe("2026-08-04 07:50:00");
    expect(new Set(supabase.reservations.map((r) => r.external_reservation_id))).toEqual(new Set(["N1-1"]));
    // No tax call on an incremental tick.
    expect(client.cloudbedsGetTaxesAndFees).not.toHaveBeenCalled();
  });
});

describe("re-syncing unchanged data writes nothing", () => {
  it("skips every row whose stored copy already matches", async () => {
    const supabase = makeSupabaseStub();
    serve([stay("R1")]);

    const first = await runCloudbedsSyncForHotel(supabase, "hotel-1");
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.reservationRowsUpserted).toBe(3);
      expect(first.ingest.unchangedRowsSkipped).toBe(0);
    }

    // Same book, next full read: the data moved nowhere, so neither should a write.
    const second = await runCloudbedsSyncForHotel(supabase, "hotel-1", { daysBack: 30 });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.reservationRowsUpserted).toBe(0);
      expect(second.ingest.unchangedRowsSkipped).toBe(3);
    }
    expect(supabase.reservations).toHaveLength(3);
  });
});

describe("a book bigger than one budget", () => {
  /** 2,400 one-night bookings, eight checking out each day from the window start. */
  function bigBook(): Json[] {
    return Array.from({ length: 2400 }, (_, i) => {
      const checkIn = new Date(Date.UTC(2026, 6, 5 + Math.floor(i / 8)));
      const checkOut = new Date(checkIn.getTime() + 86_400_000);
      const ymd = (d: Date) => d.toISOString().slice(0, 10);
      return booking({ id: String(100000 + i), status: "confirmed", checkIn: ymd(checkIn), checkOut: ymd(checkOut), nightly: 100 + (i % 50) });
    });
  }

  it("slices by check-out, checkpoints the date it reached, and resumes there until covered", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const book = bigBook();
    const supabase = makeSupabaseStub();
    const runs: Array<{ covered: boolean; cursor: string | null }> = [];

    for (let run = 0; run < 12; run += 1) {
      // Each page takes 30s of the 210s budget, and the API orders bookings
      // differently on every run: resuming must not depend on page order.
      serve(book, { orderSeed: run, onCall: () => vi.advanceTimersByTime(30_000) });
      const res = await runCloudbedsSyncForHotel(supabase, "hotel-1");
      expect(res.ok).toBe(true);
      if (!res.ok) break;
      runs.push({ covered: res.windowFullyCovered, cursor: res.sweepCursor });
      if (res.windowFullyCovered) break;
      vi.advanceTimersByTime(60_000);
    }

    expect(runs.length).toBeGreaterThan(1);
    expect(runs.at(-1)).toEqual({ covered: true, cursor: null });
    const cursors = runs.slice(0, -1).map((r) => r.cursor);
    expect(cursors.every((c) => c?.startsWith("checkout:"))).toBe(true);
    // Every uncovered run moved the checkpoint forward.
    expect([...cursors].sort()).toEqual(cursors);
    expect(new Set(cursors).size).toBe(cursors.length);

    // Every booking landed exactly once, at its own rate.
    expect(supabase.reservations).toHaveLength(2400);
    expect(new Set(supabase.reservations.map((r) => r.external_reservation_id)).size).toBe(2400);
    const sample = supabase.reservations.find((r) => r.external_reservation_id === "101234-1")!;
    expect(sample.current_rate).toBe(100 + (1234 % 50));

    // No slice ever asked for more than a page budget's worth of bookings.
    for (const q of rateDetailsQueries()) expect(q).not.toHaveProperty("status");

    // The watermark only moved on the run that finished, stamped from the sweep's start.
    const stamps = supabase.connUpdates.filter((u) => "reservations_modified_through" in u);
    expect(stamps).toHaveLength(1);
    expect(stamps[0].reservations_modified_through).toBe(NOW.toISOString());
    expect(stamps[0].full_sweep_after_id).toBeNull();
  });

  it("an explicit window never checkpoints — it is a one-shot re-read", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const supabase = makeSupabaseStub();
    serve(bigBook(), { onCall: () => vi.advanceTimersByTime(30_000) });

    const res = await runCloudbedsSyncForHotel(supabase, "hotel-1", { daysBack: 30 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.windowFullyCovered).toBe(false);
      expect(res.sweepCursor).toBeNull();
    }
    const stamp = supabase.connUpdates.at(-1)!;
    expect(stamp).not.toHaveProperty("full_sweep_after_id");
    expect(stamp).not.toHaveProperty("full_sweep_started_at");
  });

  it("ignores a checkpoint the per-booking path left behind", async () => {
    const supabase = makeSupabaseStub([], {
      full_sweep_after_id: "100500",
      full_sweep_started_at: "2026-08-04T09:00:00.000Z",
    });
    serve([stay("R1")]);

    const res = await runCloudbedsSyncForHotel(supabase, "hotel-1");

    expect(res.ok).toBe(true);
    expect(rateDetailsQueries()[0].checkOutFrom).toBe(WINDOW_START);
    expect(supabase.reservations).toHaveLength(3);
  });
});

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
    serve([stay("R1", "not_confirmed")]);
    const first = await runCloudbedsSyncForHotel(db.client, "hotel-1");

    expect(first.ok).toBe(true);
    expect(db.tables.reservations.map((r) => r.stay_date).sort()).toEqual(NIGHTS);
    // 1 of the King type's 10 rooms, every night of the stay.
    expect(await occupancyOn(db, "2026-08-01T00:00:00.000Z")).toEqual([0.1, 0.1, 0.1]);

    serve([stay("R1", "canceled")]);
    const second = await runCloudbedsSyncForHotel(db.client, "hotel-1", { daysBack: 30 });

    expect(second.ok).toBe(true);
    expect(db.tables.reservations).toEqual([]);
    expect(await occupancyOn(db, "2026-08-01T00:05:00.000Z")).toEqual([0, 0, 0]);
  });

  it("keeps one set of nights when it confirms, updated in place", async () => {
    const db = hotelDb();

    serve([stay("R1", "not_confirmed")]);
    expect((await runCloudbedsSyncForHotel(db.client, "hotel-1")).ok).toBe(true);
    expect(db.tables.reservations.map((r) => r.current_rate)).toEqual([200, 200, 200]);

    // Confirmed at a different rate: same booking, same room keys, so the
    // nights must be overwritten rather than stored a second time.
    serve([stay("R1", "confirmed", { nightly: 240 })]);
    expect((await runCloudbedsSyncForHotel(db.client, "hotel-1", { daysBack: 30 })).ok).toBe(true);

    expect(db.tables.reservations).toHaveLength(3);
    expect(db.tables.reservations.map((r) => r.current_rate)).toEqual([240, 240, 240]);
  });
});

describe("the connection status a sync leaves behind", () => {
  function syncOnce(status: string) {
    const supabase = makeSupabaseStub([], { status });
    serve([stay("R1")]);
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
    serve([stay("R1")], {
      onCall: () => {
        db.tables.pms_connections[0].status = "disconnected";
      },
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

/* ── When the account refuses rate details ──────────────────────────────── */

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
      reservations: status === "canceled" ? ids.map((id) => ({ reservationID: id })) : [],
      hasMore: false,
    }),
  );
}

function refuseRateDetails(status = 400, message = "Cloudbeds getReservationsWithRateDetails failed (400): Method not available") {
  client.cloudbedsGetReservationsWithRateDetailsPage.mockRejectedValue(
    new client.CloudbedsHttpError(message, status, "getReservationsWithRateDetails"),
  );
}

describe("when an account refuses rate details", () => {
  let errorLog: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    refuseRateDetails();
    activeList();
    canceledList();
  });

  afterEach(() => {
    errorLog.mockRestore();
  });

  it("falls back to one getReservation per booking, and says so loudly", async () => {
    const supabase = makeSupabaseStub();
    activeList("R1");
    client.cloudbedsGetReservationDetail.mockResolvedValue(detailFor("R1", "R1-1", "confirmed"));

    const res = await runCloudbedsSyncForHotel(supabase, "hotel-1");

    expect(res.ok).toBe(true);
    expect(supabase.reservations).toHaveLength(3);
    if (res.ok) {
      expect(res.ingest.source).toBe("per_booking");
      expect(res.ingest.rateDetailsRefused).toContain("Method not available");
    }
    expect(client.cloudbedsGetReservationDetail).toHaveBeenCalledWith(expect.anything(), "R1");
    expect(String(errorLog.mock.calls[0]?.[0])).toContain("getReservationsWithRateDetails refused");
  });

  it.each([
    [503, "Cloudbeds getReservationsWithRateDetails failed (503): upstream"],
    [429, "Cloudbeds getReservationsWithRateDetails failed (429): slow down"],
    [401, "Cloudbeds getReservationsWithRateDetails failed (401): token revoked"],
  ])("does not fall back on a %i — that is an outage or a revoked grant, not a refusal", async (status, message) => {
    const supabase = makeSupabaseStub([
      { external_reservation_id: "R1-1", stay_date: "2026-08-15", current_rate: 200 },
    ]);
    refuseRateDetails(status, message);

    const res = await runCloudbedsSyncForHotel(supabase, "hotel-1");

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.cloudbedsStatus).toBe(status);
    expect(client.cloudbedsGetReservationsRange).not.toHaveBeenCalled();
    expect(supabase.reservations).toHaveLength(1);
  });

  it("upserts a booking's nights, then removes them once it cancels", async () => {
    const supabase = makeSupabaseStub();

    activeList("R1");
    client.cloudbedsGetReservationDetail.mockResolvedValue(detailFor("R1", "R1-1", "confirmed"));
    const first = await runCloudbedsSyncForHotel(supabase, "hotel-1");
    expect(first.ok).toBe(true);
    expect(supabase.reservations).toHaveLength(3);

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

  it("still writes the run's active room-nights when the canceled list is refused", async () => {
    const supabase = makeSupabaseStub();
    activeList("R1");
    client.cloudbedsGetReservationDetail.mockResolvedValue(detailFor("R1", "R1-1", "confirmed"));
    client.cloudbedsGetReservationsPage.mockRejectedValue(
      new client.CloudbedsHttpError("Cloudbeds getReservations failed (503)", 503, "getReservations"),
    );

    const res = await runCloudbedsSyncForHotel(supabase, "hotel-1");

    expect(res.ok).toBe(false);
    expect(supabase.reservations).toHaveLength(3);
  });

  describe("a sweep bigger than one budget", () => {
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

    it("checkpoints where it stopped instead of forgetting everything", async () => {
      const supabase = makeSupabaseStub();
      activeList("r3", "r1", "r6", "r2", "r5", "r4");
      slowDetails();

      const res = await runCloudbedsSyncForHotel(supabase, "hotel-1");
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.windowFullyCovered).toBe(false);
        expect(res.sweepCursor).toBe("r4");
      }

      const fetched = client.cloudbedsGetReservationDetail.mock.calls.map((c) => c[1]);
      expect(fetched).toEqual(["r1", "r2", "r3", "r4"]);

      const stamp = supabase.connUpdates.at(-1)!;
      expect(stamp.full_sweep_after_id).toBe("r4");
      expect(stamp.full_sweep_started_at).toBe(T0.toISOString());
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

      const fetched = client.cloudbedsGetReservationDetail.mock.calls.map((c) => c[1]);
      expect(fetched).toEqual(["r5", "r6"]);

      const stamp = supabase.connUpdates.at(-1)!;
      expect(stamp.reservations_modified_through).toBe(sweepStart);
      expect(stamp.last_full_sync_at).toBe(sweepStart);
      expect(stamp.full_sweep_after_id).toBeNull();
      expect(stamp.full_sweep_started_at).toBeNull();
    });

    it("ignores a check-out checkpoint the rate-details path left behind", async () => {
      const supabase = makeSupabaseStub([], {
        full_sweep_after_id: "checkout:2026-09-01",
        full_sweep_started_at: "2026-08-04T09:45:00.000Z",
      });
      activeList("r2", "r1");
      client.cloudbedsGetReservationDetail.mockImplementation(async (_c: unknown, rid: string) =>
        detailFor(rid, `${rid}-1`, "confirmed"),
      );

      const res = await runCloudbedsSyncForHotel(supabase, "hotel-1");

      expect(res.ok).toBe(true);
      expect(client.cloudbedsGetReservationDetail.mock.calls.map((c) => c[1])).toEqual(["r1", "r2"]);
    });
  });
});

/* ── Writing slice by slice ───────────────────────────────────────────── */

describe("a sweep written slice by slice ends where the one-pass sweep did", () => {
  const GOLDEN = new URL("./__fixtures__/slice-sweep-golden.json", import.meta.url).pathname;
  const WRITE_GOLDEN = process.env.MAYA_WRITE_SLICE_GOLDEN === "1";

  /**
   * 2,600 bookings, enough for several check-out slices, plus the awkward
   * ones: stays that cross slice boundaries, a cancellation of stored rows,
   * a stay whose dates moved since it was stored, and bookings that change
   * between the first and a later time the sweep reads them (a cancel, a
   * reinstatement, new dates, a new room count).
   */
  function scenario() {
    const ymd = (d: Date) => d.toISOString().slice(0, 10);
    const day = (n: number) => ymd(new Date(Date.UTC(2026, 6, 5 + n)));
    const book: Json[] = [];
    for (let i = 0; i < 2600; i++) {
      const nights = 1 + (i % 4);
      const start = Math.floor(i / 7);
      book.push(booking({
        id: String(200000 + i),
        status: i % 97 === 0 ? "canceled" : "confirmed",
        checkIn: day(start),
        checkOut: day(start + nights),
        nightly: 90 + (i % 60),
        rooms: i % 13 === 0
          ? [
              { sub: `${200000 + i}-1`, rates: Object.fromEntries(nightsBetween(day(start), day(start + nights)).map((n) => [n, 120])) },
              { sub: `${200000 + i}-2`, roomTypeID: "RT2", rates: Object.fromEntries(nightsBetween(day(start), day(start + nights)).map((n) => [n, i % 2 ? null : 140])) },
            ]
          : undefined,
      }));
    }
    const seed: ResRow[] = [
      // Stored nights of a booking that is now canceled.
      ...["2026-08-01", "2026-08-02"].map((d) => ({ external_reservation_id: "200097-1", stay_date: d, room_type_id: "rt-uuid-1", current_rate: 77, booking_date: "2026-06-01", booking_window_days: 5, raw_payload: {} })),
      // A stay stored on dates it no longer holds.
      ...["2026-07-06", "2026-07-07", "2026-07-08"].map((d) => ({ external_reservation_id: "200010-1", stay_date: d, room_type_id: "rt-uuid-1", current_rate: 66, booking_date: "2026-06-01", booking_window_days: 5, raw_payload: {} })),
      // Unrelated rows outside anything the sweep reads.
      { external_reservation_id: "999999-1", stay_date: "2026-01-01", room_type_id: "rt-uuid-1", current_rate: 50, booking_date: null, booking_window_days: null, raw_payload: {} },
    ];
    // Bookings that read differently the second time they come back.
    const flips: Record<string, (seen: number, b: Json) => Json> = {};
    for (let i = 3; i < 2600; i += 41) {
      const id = String(200000 + i);
      const kind = i % 4;
      flips[id] = (seen, b) => {
        if (seen === 0) return b;
        if (kind === 0) return { ...b, status: "canceled" };
        if (kind === 1) return { ...b, status: b.status === "canceled" ? "confirmed" : "no_show" };
        if (kind === 2) {
          const checkIn = String(b.reservationCheckIn);
          const moved = ymd(new Date(Date.parse(`${checkIn}T00:00:00Z`) + 86_400_000));
          return booking({ id, status: "confirmed", checkIn: moved, checkOut: String(b.reservationCheckOut), nightly: 111 });
        }
        return booking({ id, status: "confirmed", checkIn: String(b.reservationCheckIn), checkOut: String(b.reservationCheckOut), rooms: [
          { sub: `${id}-1`, rates: Object.fromEntries(nightsBetween(String(b.reservationCheckIn), String(b.reservationCheckOut)).map((n) => [n, 150])) },
        ] });
      };
    }
    return { book, seed, flips };
  }

  function serveWithFlips(book: Json[], flips: Record<string, (seen: number, b: Json) => Json>, pageMs: number) {
    const seen = new Map<string, number>();
    const returnedTwice = new Set<string>();
    serve(book, { onCall: () => vi.advanceTimersByTime(pageMs) });
    const inner = client.cloudbedsGetReservationsWithRateDetailsPage.getMockImplementation()!;
    client.cloudbedsGetReservationsWithRateDetailsPage.mockImplementation(async (...args: unknown[]) => {
      const page = await (inner as (...a: unknown[]) => Promise<{ reservations: Json[]; hasMore: boolean; total: number }>)(...args);
      return {
        ...page,
        reservations: page.reservations.map((b) => {
          const id = String(b.reservationID);
          const n = seen.get(id) ?? 0;
          seen.set(id, n + 1);
          if (n > 0) returnedTwice.add(id);
          return flips[id] ? flips[id](n, b) : b;
        }),
      };
    });
    return { returnedTwice };
  }

  const tableOf = (rows: ResRow[]) =>
    rows
      .map((r) => [r.external_reservation_id, r.stay_date, r.room_type_id, r.current_rate, r.base_rate, r.booking_date, r.booking_window_days].join("|"))
      .sort();

  it.each([
    ["in one run", 0],
    ["resumed over several runs", 30_000],
  ] as const)("%s", async (label, pageMs) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { book, seed, flips } = scenario();
    const supabase = makeSupabaseStub(seed);
    const flipsSeen = new Set<string>();
    let runs = 0;
    for (; runs < 30; runs++) {
      const { returnedTwice } = serveWithFlips(book, flips, pageMs);
      const res = await runCloudbedsSyncForHotel(supabase, "hotel-1");
      for (const id of returnedTwice) if (flips[id]) flipsSeen.add(id);
      expect(res.ok).toBe(true);
      if (!res.ok || res.windowFullyCovered) break;
      vi.advanceTimersByTime(60_000);
    }
    const table = tableOf(supabase.reservations);
    if (WRITE_GOLDEN) {
      const { mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
      mkdirSync(new URL("./__fixtures__/", import.meta.url).pathname, { recursive: true });
      let golden: Record<string, unknown> = {};
      try {
        golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
      } catch {
        golden = {};
      }
      golden[label] = { runs: runs + 1, table };
      writeFileSync(GOLDEN, JSON.stringify(golden, null, 1) + "\n");
      return;
    }
    const { readFileSync } = await import("node:fs");
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8"))[label] as { table: string[] };
    // The sweep really did read some bookings twice with a change in between.
    if (pageMs === 0) expect(flipsSeen.size).toBeGreaterThan(0);
    expect(table.length).toBeGreaterThan(5000);
    expect(table).toEqual(golden.table);
  }, 120_000);
});

describe.skipIf(!process.env.MAYA_HEAP_PROBE)("heap on a 21,000-booking sweep (probe)", () => {
  it("reports the peak heap seen while the sweep runs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const ymd = (d: Date) => d.toISOString().slice(0, 10);
    const book: Json[] = Array.from({ length: 21_000 }, (_, i) => {
      const start = Math.floor(i / 55);
      return booking({ id: String(300000 + i), status: "confirmed", checkIn: ymd(new Date(Date.UTC(2026, 6, 5 + start))), checkOut: ymd(new Date(Date.UTC(2026, 6, 8 + start))), nightly: 100 + (i % 40) });
    });
    const supabase = makeSupabaseStub();
    let peak = 0;
    const gc = (globalThis as { gc?: () => void }).gc;
    // Live heap, after a collection, at every database call and every page:
    // the one-pass sweep's high point is while it writes at the end.
    const sample = () => {
      for (const r of supabase.reservations) delete r.raw_payload;
      gc?.();
      peak = Math.max(peak, process.memoryUsage().heapUsed);
    };
    const realFrom = supabase.from.bind(supabase);
    (supabase as unknown as { from: unknown }).from = (name: string) => {
      sample();
      return realFrom(name);
    };
    // The stub table lives in this same heap; keep only what the probe needs
    // from each stored row so it measures the sync, not the fake database.
    serve(book, { onCall: () => sample() });
    gc?.();
    const baseline = process.memoryUsage().heapUsed;
    const res = await runCloudbedsSyncForHotel(supabase, "hotel-1");
    sample();
    expect(res.ok).toBe(true);
    process.stdout.write(`HEAP_PROBE rows=${supabase.reservations.length} baselineMB=${(baseline / 1e6).toFixed(0)} gc=${gc ? "yes" : "no"} peakMB=${(peak / 1e6).toFixed(0)} deltaMB=${((peak - baseline) / 1e6).toFixed(0)}\n`);
  }, 300_000);
});
