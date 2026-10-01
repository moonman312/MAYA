/**
 * What stays stored after Cloudbeds changes its mind about a booking: a room
 * taken off it, a room cancelled inside it, the whole booking cancelled, and
 * a booking deleted outright, which Cloudbeds never mentions again.
 *
 * The harm these guard against is occupancy that reads too high, which makes
 * rules raise prices on rooms that are free. The harm the guards on the
 * guards protect against is the opposite one: rooms removed because a read
 * was short, which would send prices down.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  const c = {
    CloudbedsHttpError,
    setCloudbedsRequestLogger: vi.fn(),
    cloudbedsDiscoverPropertyId: vi.fn(async () => "prop-1"),
    cloudbedsGetTaxesAndFees: vi.fn(async () => ({ ok: false, reason: "not_granted" })),
    cloudbedsGetRoomTypes: vi.fn(async () => [
      { roomTypeID: "RT1", roomTypeName: "King", roomTypeUnits: 8 },
      { roomTypeID: "RT2", roomTypeName: "Queen", roomTypeUnits: 4 },
    ]),
    cloudbedsGetReservationsWithRateDetailsPage: vi.fn(),
    cloudbedsGetReservationsRange: vi.fn(),
    cloudbedsGetReservationsPage: vi.fn(),
    cloudbedsGetReservationDetail: vi.fn(),
    cloudbedsLookUpReservation: vi.fn(),
    cloudbedsTimestamp: (d: Date) => d.toISOString().slice(0, 19).replace("T", " "),
  };
  return {
    ...c,
    // The paged list the sync reads, built from cloudbedsGetRoomTypes so a test that stubs that still steers it.
    cloudbedsListRoomTypes: vi.fn(async (creds: unknown) => ({
      roomTypes: await (c.cloudbedsGetRoomTypes as (x: unknown) => Promise<Record<string, unknown>[]>)(creds),
      complete: true,
    })),
    // The daily details read: no time zone or currency, so nothing changes.
    cloudbedsGetHotelDetails: vi.fn(
      async (): Promise<{ externalPropertyId: string; name: string | null; timezone: string | null; currency: string | null }> => ({
        externalPropertyId: "prop-1",
        name: null,
        timezone: null,
        currency: null,
      }),
    ),
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
import { type FakeCall, type FakeError, type FakeRow, fakeSupabase } from "../engine/fake-supabase.test";
import {
  flatRates,
  type Json,
  rateDetailsBooking as booking,
  rateDetailsPage,
  type RateDetailsQuery,
  type RoomFixture,
} from "./__fixtures__/rate-details";

/** The sync window is 30 days back and 396 forward, so check-ins from 2026-07-05 are inside. */
const NOW = new Date("2026-08-04T10:00:00Z");

/** Cloudbeds reservation ids are long numbers. */
const GROUP = "5538214799001";
const OTHER = "5538214799002";

type Db = ReturnType<typeof fakeSupabase>;

function hotelDb(reservations: FakeRow[] = [], opts: { connection?: FakeRow; fault?: (call: FakeCall) => FakeError | null } = {}): Db {
  return fakeSupabase(
    {
      hotels: [{ id: "hotel-1", total_rooms_per_type: 10 }],
      pms_connections: [
        { id: "conn-1", hotel_id: "hotel-1", pms_type: "cloudbeds", status: "connected", base_url: null, ...opts.connection },
      ],
      reservations: reservations.map((r) => ({ hotel_id: "hotel-1", ...r })),
    },
    { fault: opts.fault },
  );
}

/** A connection whose last full read was an hour ago: the next run is an incremental one. */
const READ_AN_HOUR_AGO = {
  reservations_modified_through: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
  last_full_sync_at: new Date(NOW.getTime() - 60 * 60_000).toISOString(),
};

function serve(book: Json[]) {
  client.cloudbedsGetReservationsWithRateDetailsPage.mockImplementation(
    async (_creds: unknown, query: RateDetailsQuery, pageNumber: number) => rateDetailsPage(book, query, pageNumber),
  );
}

/** Stored rows as `rowId night roomType`, sorted. */
function stored(db: Db): string[] {
  const typeName = new Map(db.tables.room_types.map((rt) => [String(rt.id), String(rt.name)]));
  return db.tables.reservations
    .map((r) => `${r.external_reservation_id} ${r.stay_date} ${typeName.get(String(r.room_type_id)) ?? r.room_type_id}`)
    .sort();
}

const rowIdsOf = (db: Db) => [...new Set(db.tables.reservations.map((r) => String(r.external_reservation_id)))].sort();

/** The engine's own occupancy for the hotel on each night: snapshot what is stored, then read it. */
async function occupancy(db: Db, snapshotTs: string, nights: string[]): Promise<(number | null)[]> {
  const roomTypes = db.tables.room_types.map((rt) => ({ is_active: true, ...rt })) as unknown as RoomTypeRow[];
  await snapshotCurrentState(db.client, "hotel-1", snapshotTs, nights, roomTypes);
  return nights.map((night) => {
    const snaps = db.tables.stay_date_snapshot.filter((s) => s.snapshot_ts === snapshotTs && s.stay_date === night);
    const byType = new Map(
      snaps.map((s) => [String(s.room_type_id), { booked_units: Number(s.booked_units), sellable_units: Number(s.sellable_units) }]),
    );
    const value = computeOccupancy(byType, roomTypes.map((rt) => rt.id));
    return value == null ? null : Math.round(value * 1000) / 1000;
  });
}

/** King, Queen, King on 15 and 16 August: the booking the audit walked through. */
const NIGHTS = ["2026-08-15", "2026-08-16"];
const king = (sub: string, rate = 240): RoomFixture => ({ sub, roomTypeID: "RT1", rates: flatRates("2026-08-15", "2026-08-17", rate) });
const queen = (sub: string, rate = 180): RoomFixture => ({ sub, roomTypeID: "RT2", rates: flatRates("2026-08-15", "2026-08-17", rate) });
const group = (rooms: RoomFixture[], status = "confirmed", extra: Partial<Parameters<typeof booking>[0]> = {}) =>
  booking({ id: GROUP, status, checkIn: "2026-08-15", checkOut: "2026-08-17", rooms, ...extra });
/**
 * The booking after somebody changed it a moment ago. A run that follows a
 * full read only asks Cloudbeds for what changed since, and the server here
 * honours that, as Cloudbeds does.
 */
const changedGroup = (rooms: RoomFixture[], status = "confirmed") => group(rooms, status, { modified: "2026-08-04 09:59:30" });

/** A stored room-night, as an earlier sync left it. */
function storedNight(rowId: string, night: string, over: FakeRow = {}): FakeRow {
  return {
    id: `${rowId}:${night}`,
    external_reservation_id: rowId,
    stay_date: night,
    room_type_id: "rt-king",
    current_rate: 200,
    base_rate: 200,
    booking_date: "2026-07-01",
    booking_window_days: 40,
    raw_payload: null,
    created_at: "2026-07-01T09:31:00.000Z",
    ...over,
  };
}

let errors: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  for (const fn of [
    client.cloudbedsGetReservationsWithRateDetailsPage,
    client.cloudbedsGetReservationsRange,
    client.cloudbedsGetReservationsPage,
    client.cloudbedsGetReservationDetail,
    client.cloudbedsLookUpReservation,
  ]) {
    fn.mockReset();
  }
  client.cloudbedsLookUpReservation.mockImplementation(async () => ({ unknown: "not stubbed" }));
  serve([]);
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("a room taken off a booking", () => {
  it("leaves the booking's other rooms and nothing else, and the whole booking leaves nothing when it cancels", async () => {
    const db = hotelDb();
    serve([group([king(GROUP), queen(`${GROUP}-1`), king(`${GROUP}-2`)])]);
    expect((await runCloudbedsSyncForHotel(db.client, "hotel-1")).ok).toBe(true);
    expect(db.tables.reservations).toHaveLength(6);
    // 3 of 12 rooms.
    expect(await occupancy(db, "2026-08-04T10:00:00.000Z", NIGHTS)).toEqual([0.25, 0.25]);

    // The guest drops the Queen. Cloudbeds holds two rooms now.
    serve([changedGroup([king(GROUP), king(`${GROUP}-2`)])]);
    const second = await runCloudbedsSyncForHotel(db.client, "hotel-1");

    expect(second.ok).toBe(true);
    expect(stored(db)).toEqual([
      `${GROUP}-2 2026-08-15 King`,
      `${GROUP}-2 2026-08-16 King`,
      `${GROUP}-3 2026-08-15 King`,
      `${GROUP}-3 2026-08-16 King`,
    ]);
    if (second.ok) expect(second.ingest.roomsNoLongerOnBooking).toBe(1);
    expect(await occupancy(db, "2026-08-04T10:05:00.000Z", NIGHTS)).toEqual([0.167, 0.167]);

    // Then the whole booking cancels.
    serve([changedGroup([king(GROUP), king(`${GROUP}-2`)], "canceled")]);
    expect((await runCloudbedsSyncForHotel(db.client, "hotel-1")).ok).toBe(true);

    expect(db.tables.reservations).toEqual([]);
    expect(await occupancy(db, "2026-08-04T10:10:00.000Z", NIGHTS)).toEqual([0, 0]);
  });

  it("is removed by the five-minute read of what changed, not only by the daily read of everything", async () => {
    const db = hotelDb([], { connection: READ_AN_HOUR_AGO });
    serve([group([king(GROUP), queen(`${GROUP}-1`), king(`${GROUP}-2`)], "confirmed", { modified: "2026-08-04 09:58:00" })]);
    expect((await runCloudbedsSyncForHotel(db.client, "hotel-1")).ok).toBe(true);
    expect(db.tables.reservations).toHaveLength(6);

    serve([group([king(GROUP), king(`${GROUP}-2`)], "confirmed", { modified: "2026-08-04 09:59:00" })]);
    const res = await runCloudbedsSyncForHotel(db.client, "hotel-1");

    expect(res.ok).toBe(true);
    expect(client.cloudbedsGetReservationsWithRateDetailsPage.mock.calls.at(-1)?.[1]).toMatchObject({
      modifiedFrom: expect.any(String),
    });
    expect(rowIdsOf(db)).toEqual([`${GROUP}-2`, `${GROUP}-3`]);
  });

  it("does not move the rooms that stay onto other rows", async () => {
    const db = hotelDb();
    serve([group([king(GROUP, 240), queen(`${GROUP}-1`), king(`${GROUP}-2`, 250)])]);
    await runCloudbedsSyncForHotel(db.client, "hotel-1");
    const before = new Map(db.tables.reservations.map((r) => [`${r.external_reservation_id} ${r.stay_date}`, r.id]));

    serve([changedGroup([king(GROUP, 240), king(`${GROUP}-2`, 250)])]);
    await runCloudbedsSyncForHotel(db.client, "hotel-1");

    // The first room, whose number MAYA derived, used to slide down onto the
    // Queen's rows: new rows to booking speed, and the Queen's first rate as
    // its base. It is the same four rows, at their own rates.
    const after = db.tables.reservations.map((r) => [`${r.external_reservation_id} ${r.stay_date}`, r.id, r.current_rate]);
    expect(after.sort()).toEqual(
      [
        [`${GROUP}-2 2026-08-15`, before.get(`${GROUP}-2 2026-08-15`), 250],
        [`${GROUP}-2 2026-08-16`, before.get(`${GROUP}-2 2026-08-16`), 250],
        [`${GROUP}-3 2026-08-15`, before.get(`${GROUP}-3 2026-08-15`), 240],
        [`${GROUP}-3 2026-08-16`, before.get(`${GROUP}-3 2026-08-16`), 240],
      ].sort(),
    );
  });

  it("leaves another booking's rooms alone", async () => {
    const db = hotelDb();
    const other = booking({ id: OTHER, status: "confirmed", checkIn: "2026-08-15", checkOut: "2026-08-17", rooms: [queen(OTHER), queen(`${OTHER}-1`)] });
    serve([group([king(GROUP), queen(`${GROUP}-1`)]), other]);
    await runCloudbedsSyncForHotel(db.client, "hotel-1");

    serve([changedGroup([king(GROUP)]), other]);
    await runCloudbedsSyncForHotel(db.client, "hotel-1");

    expect(rowIdsOf(db)).toEqual([`${GROUP}-2`, `${OTHER}-1`, `${OTHER}-2`]);
  });
});

describe("a room added to a booking", () => {
  it("gets rows of its own, and the room already stored keeps its rows and its room type", async () => {
    const db = hotelDb();
    serve([group([king(GROUP)])]);
    await runCloudbedsSyncForHotel(db.client, "hotel-1");
    expect(stored(db)).toEqual([`${GROUP}-1 2026-08-15 King`, `${GROUP}-1 2026-08-16 King`]);
    const kingRows = db.tables.reservations.map((r) => r.id).sort();

    // Cloudbeds numbers the second room <id>-1, the number the first room is stored under.
    serve([changedGroup([king(GROUP), queen(`${GROUP}-1`)])]);
    await runCloudbedsSyncForHotel(db.client, "hotel-1");

    expect(stored(db)).toEqual([
      `${GROUP}-1 2026-08-15 King`,
      `${GROUP}-1 2026-08-16 King`,
      `${GROUP}-2 2026-08-15 Queen`,
      `${GROUP}-2 2026-08-16 Queen`,
    ]);
    expect(
      db.tables.reservations.filter((r) => r.external_reservation_id === `${GROUP}-1`).map((r) => r.id).sort(),
    ).toEqual(kingRows);

    // And the next read of everything finds both where it left them.
    const again = await runCloudbedsSyncForHotel(db.client, "hotel-1", { daysBack: 30 });
    if (again.ok) {
      expect(again.reservationRowsUpserted).toBe(0);
      expect(again.ingest.unchangedRowsSkipped).toBe(4);
    }
    expect(db.tables.reservations).toHaveLength(4);
    expect(rowIdsOf(db)).toEqual([`${GROUP}-1`, `${GROUP}-2`]);
  });
});

describe("a room Cloudbeds lists as cancelled", () => {
  it("is never stored, and takes nobody else's number", async () => {
    const db = hotelDb();
    serve([group([king(GROUP), { ...queen(`${GROUP}-1`), roomStatus: "cancelled" }, king(`${GROUP}-2`)])]);

    expect((await runCloudbedsSyncForHotel(db.client, "hotel-1")).ok).toBe(true);

    expect(stored(db)).toEqual([
      `${GROUP}-2 2026-08-15 King`,
      `${GROUP}-2 2026-08-16 King`,
      `${GROUP}-3 2026-08-15 King`,
      `${GROUP}-3 2026-08-16 King`,
    ]);
  });

  it.each(["cancelled", "canceled", "Cancelled", "no_show"])("loses the nights stored for it (roomStatus %s)", async (roomStatus) => {
    const db = hotelDb();
    serve([group([king(GROUP), queen(`${GROUP}-1`), king(`${GROUP}-2`)])]);
    await runCloudbedsSyncForHotel(db.client, "hotel-1");

    serve([changedGroup([king(GROUP), { ...queen(`${GROUP}-1`), roomStatus }, king(`${GROUP}-2`)])]);
    await runCloudbedsSyncForHotel(db.client, "hotel-1");

    expect(rowIdsOf(db)).toEqual([`${GROUP}-2`, `${GROUP}-3`]);
  });

  it("keeps a room that is checked in, checked out or waiting to arrive", async () => {
    const db = hotelDb();
    serve([
      group([
        { ...king(GROUP), roomStatus: "checked_in" },
        { ...queen(`${GROUP}-1`), roomStatus: "checked_out" },
        { ...king(`${GROUP}-2`), roomStatus: "not_checked_in" },
      ]),
    ]);

    await runCloudbedsSyncForHotel(db.client, "hotel-1");

    expect(db.tables.reservations).toHaveLength(6);
  });
});

describe("an answer that cannot vouch for what it leaves out", () => {
  async function storedGroup() {
    const db = hotelDb();
    serve([group([king(GROUP), queen(`${GROUP}-1`), king(`${GROUP}-2`)])]);
    await runCloudbedsSyncForHotel(db.client, "hotel-1");
    expect(db.tables.reservations).toHaveLength(6);
    return db;
  }

  it("wipes nothing when the booking comes back with no rooms at all", async () => {
    const db = await storedGroup();
    serve([changedGroup([])]);

    expect((await runCloudbedsSyncForHotel(db.client, "hotel-1")).ok).toBe(true);

    expect(db.tables.reservations).toHaveLength(6);
  });

  it("wipes nothing when the rooms come back without their rates", async () => {
    const db = await storedGroup();
    serve([changedGroup([{ sub: GROUP }, { sub: `${GROUP}-2` }])]);

    expect((await runCloudbedsSyncForHotel(db.client, "hotel-1")).ok).toBe(true);

    expect(db.tables.reservations).toHaveLength(6);
  });

  it("keeps the nights of a room that lost its rates while another room of the booking leaves", async () => {
    const db = await storedGroup();
    // The Queen is gone; the second King is listed, without rates.
    serve([changedGroup([king(GROUP), { sub: `${GROUP}-2`, roomTypeID: "RT1" }])]);

    expect((await runCloudbedsSyncForHotel(db.client, "hotel-1")).ok).toBe(true);

    expect(rowIdsOf(db)).toEqual([`${GROUP}-2`, `${GROUP}-3`]);
    expect(db.tables.reservations).toHaveLength(4);
  });

  it("stops the run, with nothing written or removed, when what is stored cannot be read", async () => {
    const db = await storedGroup();
    const failing = hotelDb(db.tables.reservations, {
      fault: (call) =>
        call.table === "reservations" && call.op === "select" && call.filters.some((f) => f.kind === "or")
          ? { message: "canceling statement due to statement timeout" }
          : null,
    });
    const before = JSON.stringify(failing.tables.reservations);
    serve([changedGroup([king(GROUP, 999)])]);

    const res = await runCloudbedsSyncForHotel(failing.client, "hotel-1");

    expect(res).toMatchObject({ ok: false, error: expect.stringContaining("statement timeout") });
    expect(JSON.stringify(failing.tables.reservations)).toBe(before);
    expect(failing.calls.some((c) => c.table === "reservations" && (c.op === "delete" || c.op === "upsert"))).toBe(false);
  });
});

describe("rooms that were already stale when this shipped", () => {
  /** What the old sync left after the Queen was dropped: the first room on the Queen's rows, and its old rows behind. */
  const leftBehind = () => [
    ...NIGHTS.map((n) => storedNight(`${GROUP}-1`, n, { base_rate: 180, current_rate: 240, raw_payload: { subReservationID: GROUP, roomTypeID: "RT1", _redacted: true } })),
    ...NIGHTS.map((n) => storedNight(`${GROUP}-2`, n, { base_rate: 250, current_rate: 250, raw_payload: { subReservationID: `${GROUP}-2`, roomTypeID: "RT1", _redacted: true } })),
    ...NIGHTS.map((n) => storedNight(`${GROUP}-3`, n, { base_rate: 240, current_rate: 240, raw_payload: { subReservationID: GROUP, roomTypeID: "RT1", _redacted: true } })),
  ];

  it("are put right by the next read of the booking: two rooms, the first on the rows it was first written to", async () => {
    const db = hotelDb(leftBehind());
    serve([group([king(GROUP, 240), king(`${GROUP}-2`, 250)])]);

    const res = await runCloudbedsSyncForHotel(db.client, "hotel-1");

    expect(res.ok).toBe(true);
    expect(rowIdsOf(db)).toEqual([`${GROUP}-2`, `${GROUP}-3`]);
    // The rows that carry the first room's own first rate, not the Queen's.
    expect(db.tables.reservations.map((r) => r.base_rate).sort()).toEqual([240, 240, 250, 250]);
    if (res.ok) expect(res.ingest.roomsNoLongerOnBooking).toBe(1);
  });

  it("are all removed when the booking is cancelled, whichever rooms Cloudbeds still lists on it", async () => {
    const db = hotelDb(leftBehind());
    serve([group([king(GROUP), king(`${GROUP}-2`)], "canceled")]);

    expect((await runCloudbedsSyncForHotel(db.client, "hotel-1")).ok).toBe(true);

    expect(db.tables.reservations).toEqual([]);
  });

  it("are removed with a no-show too, even when its payload lists no rooms", async () => {
    const db = hotelDb(leftBehind());
    serve([group([], "no_show")]);

    expect((await runCloudbedsSyncForHotel(db.client, "hotel-1")).ok).toBe(true);

    expect(db.tables.reservations).toEqual([]);
  });

  it("keep rows the history import stored without a payload where they are", async () => {
    // No payload says which room these are, so the first room takes the lowest number, as it always did.
    const db = hotelDb(NIGHTS.map((n) => storedNight(`${GROUP}-1`, n)));
    serve([group([king(GROUP)])]);

    await runCloudbedsSyncForHotel(db.client, "hotel-1");

    expect(db.tables.reservations.map((r) => r.id).sort()).toEqual(NIGHTS.map((n) => `${GROUP}-1:${n}`));
  });

  it("drop the copy stored under the booking's bare id from before rooms were keyed", async () => {
    const db = hotelDb([...NIGHTS.map((n) => storedNight(GROUP, n)), ...NIGHTS.map((n) => storedNight(`${GROUP}-1`, n))]);
    serve([group([king(GROUP)])]);

    await runCloudbedsSyncForHotel(db.client, "hotel-1");

    expect(rowIdsOf(db)).toEqual([`${GROUP}-1`]);
  });
});

describe("a booking deleted in Cloudbeds", () => {
  const DELETED = "5538214799003";
  /** Stored from 2 August to 6 August: two nights gone by, three still to come. */
  const deletedStay = () =>
    ["2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06"].map((n) => storedNight(`${DELETED}-1`, n));
  const futureNightsOf = (db: Db, rowId: string) =>
    db.tables.reservations.filter((r) => r.external_reservation_id === rowId).map((r) => r.stay_date).sort();

  it("loses its nights from today on once a full read leaves it out and Cloudbeds says it has no such booking", async () => {
    const db = hotelDb(deletedStay());
    serve([group([king(GROUP)])]);
    client.cloudbedsLookUpReservation.mockImplementation(async () => ({ gone: "Cloudbeds getReservation failed (200): Reservation not found" }));

    const res = await runCloudbedsSyncForHotel(db.client, "hotel-1");

    expect(res.ok).toBe(true);
    expect(client.cloudbedsLookUpReservation.mock.calls.map((c) => c[1])).toEqual([DELETED]);
    // The nights already slept are history and stay.
    expect(futureNightsOf(db, `${DELETED}-1`)).toEqual(["2026-08-02", "2026-08-03"]);
    expect(rowIdsOf(db)).toContain(`${GROUP}-1`);
    if (res.ok) {
      expect(res.ingest.missingBookings).toEqual({ checked: true, stored: 2, missing: 1, removed: 1, stillHeld: 0, unconfirmed: 0 });
    }
  });

  it("loses every room stored for it", async () => {
    const db = hotelDb([
      ...["2026-08-10", "2026-08-11"].flatMap((n) => [storedNight(`${DELETED}-1`, n), storedNight(`${DELETED}-2`, n), storedNight(`${DELETED}-3`, n)]),
    ]);
    serve([group([king(GROUP)])]);
    client.cloudbedsLookUpReservation.mockImplementation(async () => ({ gone: "not found" }));

    expect((await runCloudbedsSyncForHotel(db.client, "hotel-1")).ok).toBe(true);

    expect(rowIdsOf(db)).toEqual([`${GROUP}-1`]);
    expect(client.cloudbedsLookUpReservation).toHaveBeenCalledTimes(1);
  });

  it("stays when the full read returned no booking at all: a read that empty went wrong, not the hotel", async () => {
    // Three bookings ahead, all within the limit a small book allows, and
    // Cloudbeds answers with an empty book and would call each one gone.
    const db = hotelDb([DELETED, OTHER, "5538214799009"].flatMap((id) => ["2026-08-10", "2026-08-11"].map((n) => storedNight(`${id}-1`, n))));
    serve([]);
    client.cloudbedsLookUpReservation.mockImplementation(async () => ({ gone: "not found" }));

    const res = await runCloudbedsSyncForHotel(db.client, "hotel-1");

    expect(res.ok).toBe(true);
    expect(db.tables.reservations).toHaveLength(6);
    expect(client.cloudbedsLookUpReservation).not.toHaveBeenCalled();
    if (res.ok) {
      expect(res.ingest.missingBookings).toEqual({
        checked: true,
        stored: 3,
        missing: 3,
        removed: 0,
        stillHeld: 0,
        unconfirmed: 3,
        overLimit: true,
        emptyRead: true,
      });
    }
    expect(errors.mock.calls.some((c: unknown[]) => String(c[0]).includes("returned no booking"))).toBe(true);
    // Raised to the alert channel too, as the limit is (here with nowhere to go).
    expect(errors.mock.calls.some((c: unknown[]) => String(c[0]).includes('"key":"cloudbeds_missing_bookings:hotel-1"'))).toBe(true);
  });

  it("keeps its nights when Cloudbeds still holds it: the read missed it, the booking is real", async () => {
    const db = hotelDb(deletedStay());
    serve([group([king(GROUP)])]);
    client.cloudbedsLookUpReservation.mockImplementation(async () => ({
      found: { reservationID: DELETED, status: "confirmed", assigned: [] },
    }));

    const res = await runCloudbedsSyncForHotel(db.client, "hotel-1");

    expect(res.ok).toBe(true);
    expect(futureNightsOf(db, `${DELETED}-1`)).toHaveLength(5);
    if (res.ok) expect(res.ingest.missingBookings).toMatchObject({ missing: 1, removed: 0, stillHeld: 1 });
    // Said where someone will see it: a full read that leaves out a live booking is a fault.
    expect(errors.mock.calls.some((c: unknown[]) => String(c[0]).includes('"stillHeld":1'))).toBe(true);
  });

  it("keeps its nights when Cloudbeds gives no answer about it", async () => {
    const db = hotelDb(deletedStay());
    serve([group([king(GROUP)])]);
    client.cloudbedsLookUpReservation.mockImplementation(async () => ({ unknown: "Cloudbeds getReservation failed (503): Service Unavailable" }));

    const res = await runCloudbedsSyncForHotel(db.client, "hotel-1");

    expect(res.ok).toBe(true);
    expect(futureNightsOf(db, `${DELETED}-1`)).toHaveLength(5);
    if (res.ok) expect(res.ingest.missingBookings).toMatchObject({ missing: 1, removed: 0, unconfirmed: 1 });
    expect(client.cloudbedsLookUpReservation).toHaveBeenCalledTimes(1);
  });

  it("loses all of its nights when Cloudbeds has it as cancelled", async () => {
    const db = hotelDb(deletedStay());
    serve([group([king(GROUP)])]);
    client.cloudbedsLookUpReservation.mockImplementation(async () => ({
      found: { reservationID: DELETED, status: "canceled", assigned: [] },
    }));

    expect((await runCloudbedsSyncForHotel(db.client, "hotel-1")).ok).toBe(true);

    expect(rowIdsOf(db)).toEqual([`${GROUP}-1`]);
  });

  it("is removed from the same pages when Cloudbeds returns it flagged as deleted", async () => {
    const db = hotelDb(deletedStay());
    serve([booking({ id: DELETED, status: "confirmed", checkIn: "2026-08-02", checkOut: "2026-08-07", isDeleted: true })]);

    expect((await runCloudbedsSyncForHotel(db.client, "hotel-1")).ok).toBe(true);

    expect(db.tables.reservations).toEqual([]);
    expect(client.cloudbedsLookUpReservation).not.toHaveBeenCalled();
  });
});

describe("a read that cannot say a booking is gone", () => {
  const STORED = "5538214799004";
  const storedStay = () => ["2026-08-20", "2026-08-21"].map((n) => storedNight(`${STORED}-1`, n));
  const saysGone = () => client.cloudbedsLookUpReservation.mockImplementation(async () => ({ gone: "not found" }));

  async function expectUntouched(db: Db, run: Awaited<ReturnType<typeof runCloudbedsSyncForHotel>>, why: string) {
    expect(db.tables.reservations.filter((r) => r.external_reservation_id === `${STORED}-1`)).toHaveLength(2);
    expect(client.cloudbedsLookUpReservation).not.toHaveBeenCalled();
    expect(run.ok).toBe(true);
    if (run.ok) expect(run.ingest.missingBookings).toEqual({ checked: false, why });
  }

  it("the five-minute read of what changed: it only ever returns what somebody touched", async () => {
    const db = hotelDb(storedStay(), { connection: READ_AN_HOUR_AGO });
    saysGone();

    await expectUntouched(db, await runCloudbedsSyncForHotel(db.client, "hotel-1"), "incremental_read");
  });

  it("a page that came back short of the count Cloudbeds gave", async () => {
    const db = hotelDb(storedStay());
    saysGone();
    const book = Array.from({ length: 60 }, (_, i) =>
      booking({ id: String(7700000000000 + i), status: "confirmed", checkIn: "2026-09-01", checkOut: "2026-09-02" }),
    );
    // 250 bookings by its own count, 60 of them in the answer, and no more pages.
    client.cloudbedsGetReservationsWithRateDetailsPage.mockImplementation(async () => ({
      reservations: book,
      hasMore: false,
      total: 250,
    }));

    await expectUntouched(db, await runCloudbedsSyncForHotel(db.client, "hotel-1"), "read_incomplete");
    // What it did return is stored as usual.
    expect(db.tables.reservations).toHaveLength(62);
  });

  it("an answer that gives no count to hold it to", async () => {
    const db = hotelDb(storedStay());
    saysGone();
    client.cloudbedsGetReservationsWithRateDetailsPage.mockImplementation(async () => ({
      reservations: [group([king(GROUP)])],
      hasMore: false,
      total: null,
    }));

    await expectUntouched(db, await runCloudbedsSyncForHotel(db.client, "hotel-1"), "read_incomplete");
  });

  it("a page that repeats a booking while another slips between pages", async () => {
    const db = hotelDb(storedStay());
    saysGone();
    const book = Array.from({ length: 150 }, (_, i) =>
      booking({ id: String(7700000000000 + i), status: "confirmed", checkIn: "2026-09-01", checkOut: "2026-09-02" }),
    );
    // Page 2 starts one booking early: 150 rows in all, 149 different bookings.
    client.cloudbedsGetReservationsWithRateDetailsPage.mockImplementation(
      async (_creds: unknown, _query: RateDetailsQuery, pageNumber: number) =>
        pageNumber === 1
          ? { reservations: book.slice(0, 100), hasMore: true, total: 150 }
          : { reservations: book.slice(99, 149), hasMore: false, total: 150 },
    );

    await expectUntouched(db, await runCloudbedsSyncForHotel(db.client, "hotel-1"), "read_incomplete");
  });

  it("a read that ran into the page limit", async () => {
    const db = hotelDb(storedStay());
    saysGone();
    // Every page says there is another. The sync gives up at its limit; what it read is not everything.
    client.cloudbedsGetReservationsWithRateDetailsPage.mockImplementation(async () => ({
      reservations: [group([king(GROUP)])],
      hasMore: true,
      total: 1,
    }));

    await expectUntouched(db, await runCloudbedsSyncForHotel(db.client, "hotel-1"), "read_incomplete");
    expect(client.cloudbedsGetReservationsWithRateDetailsPage).toHaveBeenCalledTimes(1000);
  });

  it("a read its time budget cut short", async () => {
    const db = hotelDb(storedStay());
    saysGone();
    const book = Array.from({ length: 250 }, (_, i) =>
      booking({ id: String(7700000000000 + i), status: "confirmed", checkIn: "2026-09-01", checkOut: "2026-09-02" }),
    );
    client.cloudbedsGetReservationsWithRateDetailsPage.mockImplementation(
      async (_creds: unknown, query: RateDetailsQuery, pageNumber: number) => {
        // Each page takes two minutes; the budget is three and a half.
        vi.setSystemTime(new Date(Date.now() + 120_000));
        return rateDetailsPage(book, query, pageNumber);
      },
    );

    const res = await runCloudbedsSyncForHotel(db.client, "hotel-1");

    if (res.ok) expect(res.windowFullyCovered).toBe(false);
    await expectUntouched(db, res, "read_cut_short");
  });

  it("a read that picks a sweep up from where an earlier run stopped", async () => {
    const db = hotelDb(storedStay(), {
      connection: { full_sweep_after_id: "checkout:2026-09-10", full_sweep_started_at: "2026-08-04T09:55:00.000Z" },
    });
    saysGone();
    serve([booking({ id: OTHER, status: "confirmed", checkIn: "2026-09-12", checkOut: "2026-09-14" })]);

    await expectUntouched(db, await runCloudbedsSyncForHotel(db.client, "hotel-1"), "read_resumed");
  });

  it("a read that failed part way: the run fails and nothing is removed", async () => {
    const db = hotelDb(storedStay());
    saysGone();
    client.cloudbedsGetReservationsWithRateDetailsPage.mockImplementation(async () => {
      throw new client.CloudbedsHttpError("Cloudbeds getReservationsWithRateDetails failed (503): upstream", 503, "getReservationsWithRateDetails");
    });

    const res = await runCloudbedsSyncForHotel(db.client, "hotel-1");

    expect(res).toMatchObject({ ok: false, cloudbedsStatus: 503 });
    expect(db.tables.reservations).toHaveLength(2);
    expect(client.cloudbedsLookUpReservation).not.toHaveBeenCalled();
  });

  it("the slow read, one booking at a time, for an account that refuses rate details", async () => {
    const db = hotelDb(storedStay());
    saysGone();
    client.cloudbedsGetReservationsWithRateDetailsPage.mockImplementation(async () => {
      throw new client.CloudbedsHttpError("Cloudbeds getReservationsWithRateDetails failed (400): not available", 400, "getReservationsWithRateDetails");
    });
    client.cloudbedsGetReservationsRange.mockResolvedValue({ reservations: [], pages: 1 });
    client.cloudbedsGetReservationsPage.mockResolvedValue({ reservations: [], hasMore: false });

    await expectUntouched(db, await runCloudbedsSyncForHotel(db.client, "hotel-1"), "per_booking_read");
  });
});

describe("stored bookings a full read is not asked about", () => {
  const saysGone = () => client.cloudbedsLookUpReservation.mockImplementation(async () => ({ gone: "not found" }));

  it("a stay whose nights are all in the past: the read's window does not reach it", async () => {
    // Checked out on 1 June, long before the first day the read asks about.
    const db = hotelDb(["2026-05-30", "2026-05-31"].map((n) => storedNight("5538214799005-1", n)));
    saysGone();

    const res = await runCloudbedsSyncForHotel(db.client, "hotel-1");

    expect(db.tables.reservations).toHaveLength(2);
    expect(client.cloudbedsLookUpReservation).not.toHaveBeenCalled();
    if (res.ok) expect(res.ingest.missingBookings).toMatchObject({ checked: true, stored: 0, missing: 0 });
  });

  it("a stay that ended yesterday, still inside the read's window", async () => {
    const db = hotelDb(["2026-08-02", "2026-08-03"].map((n) => storedNight("5538214799005-1", n)));
    saysGone();

    await runCloudbedsSyncForHotel(db.client, "hotel-1");

    expect(db.tables.reservations).toHaveLength(2);
    expect(client.cloudbedsLookUpReservation).not.toHaveBeenCalled();
  });

  it("a booking arriving after the last day MAYA stores: Cloudbeds returned it, so it is not missing", async () => {
    const FAR = "5538214799006";
    const db = hotelDb(["2027-10-01", "2027-10-02"].map((n) => storedNight(`${FAR}-1`, n)));
    saysGone();
    serve([booking({ id: FAR, status: "confirmed", checkIn: "2027-10-01", checkOut: "2027-10-03" })]);

    const res = await runCloudbedsSyncForHotel(db.client, "hotel-1");

    expect(db.tables.reservations).toHaveLength(2);
    expect(client.cloudbedsLookUpReservation).not.toHaveBeenCalled();
    if (res.ok) expect(res.ingest.bookingsOutsideWindow).toBe(1);
  });

  it("a booking in a status MAYA does not recognise: Cloudbeds returned it", async () => {
    const db = hotelDb(["2026-08-20"].map((n) => storedNight("5538214799007-1", n)));
    saysGone();
    serve([booking({ id: "5538214799007", status: "some_new_status", checkIn: "2026-08-20", checkOut: "2026-08-21" })]);

    await runCloudbedsSyncForHotel(db.client, "hotel-1");

    expect(db.tables.reservations).toHaveLength(1);
    expect(client.cloudbedsLookUpReservation).not.toHaveBeenCalled();
  });

  it("rows that are not Cloudbeds': a demo seed, another system's ids", async () => {
    const db = hotelDb([
      storedNight("cb-260920-0001234", "2026-08-20"),
      storedNight("3f2b8c1e-7a4d-4e0b-9a51-0c6d2f1e8b77", "2026-08-20"),
      storedNight("88231:2", "2026-08-20"),
      storedNight("RES-1234", "2026-08-20"),
    ]);
    saysGone();

    await runCloudbedsSyncForHotel(db.client, "hotel-1");

    expect(db.tables.reservations).toHaveLength(4);
    expect(client.cloudbedsLookUpReservation).not.toHaveBeenCalled();
  });
});

describe("a read that leaves out more bookings than anyone deletes in a day", () => {
  it("removes none of them, and says so", async () => {
    // Forty bookings stored with nights to come, and Cloudbeds answers with an empty book.
    const seed = Array.from({ length: 40 }, (_, i) => storedNight(`${8800000000000 + i}-1`, "2026-08-20"));
    const db = hotelDb(seed);
    client.cloudbedsLookUpReservation.mockImplementation(async () => ({ gone: "not found" }));
    serve([]);

    const res = await runCloudbedsSyncForHotel(db.client, "hotel-1");

    expect(res.ok).toBe(true);
    expect(db.tables.reservations).toHaveLength(40);
    expect(client.cloudbedsLookUpReservation).not.toHaveBeenCalled();
    if (res.ok) {
      expect(res.ingest.missingBookings).toEqual({
        checked: true,
        stored: 40,
        missing: 40,
        removed: 0,
        stillHeld: 0,
        unconfirmed: 40,
        overLimit: true,
        emptyRead: true,
      });
    }
    expect(errors.mock.calls.some((c: unknown[]) => String(c[0]).includes("returned no booking"))).toBe(true);
  });

  it("removes none of them when the read left out more than the limit, however many it returned", async () => {
    // Forty stored, ten of them in Cloudbeds' answer: thirty missing is more than a fifth.
    const kept = Array.from({ length: 10 }, (_, i) => String(8800000000500 + i));
    const missing = Array.from({ length: 30 }, (_, i) => String(8800000000600 + i));
    const db = hotelDb([...kept, ...missing].map((id) => storedNight(`${id}-1`, "2026-08-20")));
    client.cloudbedsLookUpReservation.mockImplementation(async () => ({ gone: "not found" }));
    serve(kept.map((id) => booking({ id, status: "confirmed", checkIn: "2026-08-20", checkOut: "2026-08-21" })));

    const res = await runCloudbedsSyncForHotel(db.client, "hotel-1");

    expect(res.ok).toBe(true);
    expect(db.tables.reservations).toHaveLength(40);
    expect(client.cloudbedsLookUpReservation).not.toHaveBeenCalled();
    if (res.ok) {
      expect(res.ingest.missingBookings).toEqual({ checked: true, stored: 40, missing: 30, removed: 0, stillHeld: 0, unconfirmed: 30, overLimit: true });
    }
    expect(errors.mock.calls.some((c: unknown[]) => String(c[0]).includes("too many stored bookings missing"))).toBe(true);
  });

  it("still removes a handful from a small book", async () => {
    // A 12-room hotel with eight bookings ahead, three of them deleted in Cloudbeds.
    const kept = Array.from({ length: 5 }, (_, i) => String(8800000000100 + i));
    const deleted = Array.from({ length: 3 }, (_, i) => String(8800000000200 + i));
    const db = hotelDb([...kept, ...deleted].map((id) => storedNight(`${id}-1`, "2026-08-20")));
    client.cloudbedsLookUpReservation.mockImplementation(async () => ({ gone: "not found" }));
    serve(kept.map((id) => booking({ id, status: "confirmed", checkIn: "2026-08-20", checkOut: "2026-08-21" })));

    const res = await runCloudbedsSyncForHotel(db.client, "hotel-1");

    expect(rowIdsOf(db)).toEqual(kept.map((id) => `${id}-1`));
    if (res.ok) expect(res.ingest.missingBookings).toMatchObject({ stored: 8, missing: 3, removed: 3 });
  });

  it("stops asking when the run's time is up, and leaves the rest for the next full read", async () => {
    const ids = Array.from({ length: 4 }, (_, i) => String(8800000000300 + i));
    const others = Array.from({ length: 30 }, (_, i) => String(8800000000400 + i));
    const db = hotelDb([...ids, ...others].map((id) => storedNight(`${id}-1`, "2026-08-20")));
    serve(others.map((id) => booking({ id, status: "confirmed", checkIn: "2026-08-20", checkOut: "2026-08-21" })));
    client.cloudbedsLookUpReservation.mockImplementation(async () => {
      // Each question takes two minutes of a budget of three and a half.
      vi.setSystemTime(new Date(Date.now() + 120_000));
      return { gone: "not found" };
    });

    const res = await runCloudbedsSyncForHotel(db.client, "hotel-1");

    expect(client.cloudbedsLookUpReservation).toHaveBeenCalledTimes(2);
    if (res.ok) expect(res.ingest.missingBookings).toMatchObject({ missing: 4, removed: 2, unconfirmed: 2 });
    expect(rowIdsOf(db)).toEqual([...ids.slice(2), ...others].map((id) => `${id}-1`).sort());
  });
});
