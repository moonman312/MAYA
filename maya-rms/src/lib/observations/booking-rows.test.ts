/**
 * Booking speed counts bookings, not rooms (Jake, 2026-09-20). A reservation
 * with several rooms is one booking on each of its nights, counted at its
 * earliest booking date across those rooms; occupancy keeps counting rooms.
 * The rows of one booking are found from the PMS row id alone
 * (bookingKeyOf), so the shapes here come from the parsers, not from memory.
 */
import { describe, expect, it } from "vitest";
import {
  cloudbedsRoomRowIds,
  parseCloudbedsReservationDetail,
  parseCloudbedsReservations,
} from "../../../supabase/functions/_shared/cloudbeds/etl";
import { parseThinkReservations } from "../../../supabase/functions/_shared/think/etl";
import { addDays } from "./calendar";
import {
  StayDateWindowsBuilder,
  bookingKeyOf,
  earliestBookingWindow,
  indexBookingRows,
  indexRoomRows,
  pickupInWindow,
  pickupInWindowIndexed,
  type SlimReservationRow,
} from "./booking-rows";
import { observeBookingSpeed } from "./expected-bookings";
import { estimateMomentumFallback } from "./momentum";
import type { ComparableSelection } from "./comparable-dates";

const MEWS_GUID = "0d3a8c2e-1f4b-4c5d-9e6f-7a8b9c0d1e2f";

describe("bookingKeyOf", () => {
  it("keys every room of a Cloudbeds booking to its reservation, as the parsers key the rows", () => {
    // cloudbedsRoomRowIds: `<reservationID>-<n>` for every slot, explicit
    // sub ids honoured only inside that namespace.
    const ids = cloudbedsRoomRowIds("6364686337417", [null, { subReservationID: "6364686337417-3" }, null, null]);
    expect(ids).toEqual(["6364686337417-1", "6364686337417-3", "6364686337417-2", "6364686337417-4"]);
    expect(new Set(ids.map(bookingKeyOf))).toEqual(new Set(["6364686337417"]));

    // The detail parse, one row per room per night.
    const detail = parseCloudbedsReservationDetail({
      reservationID: "6364686337417",
      status: "confirmed",
      dateCreated: "2026-01-05",
      assigned: [
        { roomTypeID: "rt1", dailyRates: [{ date: "2026-06-06", rate: 200 }] },
        { roomTypeID: "rt1", dailyRates: [{ date: "2026-06-06", rate: 210 }] },
      ],
    });
    expect(detail.rows.map((r) => r.external_reservation_id)).toEqual(["6364686337417-1", "6364686337417-2"]);
    expect(detail.rows.map((r) => bookingKeyOf(r.external_reservation_id))).toEqual(["6364686337417", "6364686337417"]);

    // The list parse of a booking that only declares a room count.
    const list = parseCloudbedsReservations([
      { reservationID: "77", status: "confirmed", startDate: "2026-06-06", endDate: "2026-06-07", dateCreated: "2026-01-05", roomsQuantity: 3 },
    ]);
    expect(list.reservations.map((r) => r.external_reservation_id).sort()).toEqual(["77-1", "77-2", "77-3"]);
    expect(new Set(list.reservations.map((r) => bookingKeyOf(r.external_reservation_id)))).toEqual(new Set(["77"]));

    // A row written before rooms were keyed carries the bare reservation id.
    expect(bookingKeyOf("6364686337417")).toBe("6364686337417");
  });

  it("keys every booking of a Think reservation to the reservation", () => {
    const { rows } = parseThinkReservations(
      [
        {
          id: "res_1",
          status: "scheduled",
          createdAt: "2026-05-15T18:00:00Z",
          bookings: [
            { id: "book_1", roomTypeId: "rt_king", startDate: "2026-06-01", endDate: "2026-06-02" },
            { id: "book_2", roomTypeId: "rt_king", startDate: "2026-06-01", endDate: "2026-06-02" },
            { roomTypeId: "rt_king", startDate: "2026-06-01", endDate: "2026-06-02" },
          ],
          lineItems: [],
        },
      ],
      { hotelTimeZone: "UTC" },
    );
    expect(rows.map((r) => r.external_reservation_id)).toEqual(["res_1:book_1", "res_1:book_2", "res_1:3"]);
    expect(new Set(rows.map((r) => bookingKeyOf(r.external_reservation_id)))).toEqual(new Set(["res_1"]));
  });

  it("never groups Mews, whose ids are GUIDs, even one ending in digits", () => {
    expect(bookingKeyOf(MEWS_GUID)).toBe(MEWS_GUID);
    const digitsTail = "0d3a8c2e-1f4b-4c5d-9e6f-123456789012";
    expect(bookingKeyOf(digitsTail)).toBe(digitsTail);
  });

  it("leaves every other shape alone: the seeded ids, and any word-<n> id", () => {
    // Keying RES-1234 to RES would fold a whole hotel into one booking.
    for (const id of ["cb-260920-0001234", "think-1001-20260920-001", "e2e-rt-20260920-001", "demo-a-b-20260920-001", "R4", "R1-1", "ext-12", "RES-1234", "abc-", "-1", "1234-1a", "1234-x1", "1234-", "", "res_1"]) {
      expect(bookingKeyOf(id)).toBe(id);
    }
    // Digits, one hyphen, digits: a room of a Cloudbeds reservation.
    expect(bookingKeyOf("1234-01")).toBe("1234");
    expect(bookingKeyOf("6364686337417-20")).toBe("6364686337417");
    // The colon wins over a hyphen: a Think booking id may carry one.
    expect(bookingKeyOf("res_1:b-1")).toBe("res_1");
    expect(bookingKeyOf("a-1:b")).toBe("a-1");
  });
});

describe("earliestBookingWindow", () => {
  it("keeps the longest known lead time and never lets an unknown one hide it", () => {
    expect(earliestBookingWindow(3, 40)).toBe(40);
    expect(earliestBookingWindow(40, 3)).toBe(40);
    expect(earliestBookingWindow(null, 3)).toBe(3);
    expect(earliestBookingWindow(3, null)).toBe(3);
    expect(earliestBookingWindow(null, null)).toBeNull();
  });
});

const NIGHT = "2026-06-06";

/** A reservation of `rooms` rooms for NIGHT, keyed the Cloudbeds way, every room booked on `bookedOn`. */
function reservation(id: string, rooms: number, bookedOn: string): SlimReservationRow[] {
  return Array.from({ length: rooms }, (_, i) => ({
    stay_date: NIGHT,
    booking_date: bookedOn,
    external_reservation_id: `${id}-${i + 1}`,
  }));
}

describe("indexBookingRows", () => {
  it("counts a 20-room reservation once for pace, while the room index counts 20", () => {
    const rows = [...reservation("6364686337417", 20, "2026-04-27"), ...reservation("55", 1, "2026-04-27")];
    const bookings = indexBookingRows(rows).get(NIGHT)!;
    expect(bookings).toEqual({ n: 2, windows: [{ bw: 40, n: 2 }] });
    expect(pickupInWindowIndexed(indexBookingRows(rows), NIGHT, 40, 1)).toBe(2);
    expect(pickupInWindow(rows, NIGHT, 40, 1)).toBe(2);
    // Occupancy's unit, the season model's fullness input.
    expect(indexRoomRows(rows).get(NIGHT)).toEqual({ n: 21, windows: [{ bw: 40, n: 21 }] });
  });

  it("counts a booking at its earliest booking date, so rooms added to it later are not new bookings", () => {
    const rows: SlimReservationRow[] = [
      ...reservation("9001", 10, "2026-04-27"),
      // Ten more rooms added to the same reservation a month on.
      ...Array.from({ length: 10 }, (_, i) => ({ stay_date: NIGHT, booking_date: "2026-05-27", external_reservation_id: `9001-${i + 11}` })),
    ];
    expect(indexBookingRows(rows).get(NIGHT)).toEqual({ n: 1, windows: [{ bw: 40, n: 1 }] });
    // Nothing new in the window the later rooms fell into.
    expect(pickupInWindowIndexed(indexBookingRows(rows), NIGHT, 10, 7)).toBe(0);
    expect(pickupInWindowIndexed(indexBookingRows(rows), NIGHT, 40, 1)).toBe(1);
    // Row order changes nothing.
    expect(indexBookingRows([...rows].reverse()).get(NIGHT)).toEqual({ n: 1, windows: [{ bw: 40, n: 1 }] });
  });

  it("gives a booking the one known lead time among its rooms, and none only when no room has one", () => {
    const known: SlimReservationRow[] = [
      { stay_date: NIGHT, external_reservation_id: "9002-1" },
      { stay_date: NIGHT, external_reservation_id: "9002-2", booking_window_days: 12 },
    ];
    expect(indexBookingRows(known).get(NIGHT)).toEqual({ n: 1, windows: [{ bw: 12, n: 1 }] });
    const unknown: SlimReservationRow[] = [
      { stay_date: NIGHT, external_reservation_id: "9003-1" },
      { stay_date: NIGHT, external_reservation_id: "9003-2" },
    ];
    expect(indexBookingRows(unknown).get(NIGHT)).toEqual({ n: 1, windows: [{ bw: null, n: 1 }] });
  });

  it("keeps a booking's nights apart: one booking per stay date", () => {
    const rows: SlimReservationRow[] = [];
    for (const night of [NIGHT, addDays(NIGHT, 1)]) {
      for (let i = 1; i <= 3; i++) rows.push({ stay_date: night, booking_date: "2026-04-27", external_reservation_id: `9004-${i}` });
    }
    const index = indexBookingRows(rows);
    expect(index.get(NIGHT)).toEqual({ n: 1, windows: [{ bw: 40, n: 1 }] });
    expect(index.get(addDays(NIGHT, 1))).toEqual({ n: 1, windows: [{ bw: 41, n: 1 }] });
  });

  it("treats a row with no id, or an empty one, as a booking of its own, as every test row before this had", () => {
    const rows: SlimReservationRow[] = [
      { stay_date: NIGHT, booking_window_days: 5 },
      { stay_date: NIGHT, booking_window_days: 5 },
      { stay_date: NIGHT, booking_window_days: 5, external_reservation_id: null },
      { stay_date: NIGHT, booking_window_days: 5, external_reservation_id: "" },
    ];
    expect(indexBookingRows(rows).get(NIGHT)).toEqual({ n: 4, windows: [{ bw: 5, n: 4 }] });
  });

  it("does not mix Think, Cloudbeds and Mews shapes on one night", () => {
    const rows: SlimReservationRow[] = [
      { stay_date: NIGHT, booking_window_days: 5, external_reservation_id: "res_1:b1" },
      { stay_date: NIGHT, booking_window_days: 5, external_reservation_id: "res_1:b2" },
      { stay_date: NIGHT, booking_window_days: 5, external_reservation_id: "77-1" },
      { stay_date: NIGHT, booking_window_days: 5, external_reservation_id: MEWS_GUID },
      { stay_date: NIGHT, booking_window_days: 5, external_reservation_id: "77" },
    ];
    // res_1 (Think, twice), 77 (the -1 row and the bare one), the GUID.
    expect(indexBookingRows(rows).get(NIGHT)!.n).toBe(3);
  });
});

describe("StayDateWindowsBuilder", () => {
  it("gives the same index whether nights are sealed as they pass or all at the end", () => {
    const rows: SlimReservationRow[] = [];
    for (let d = 0; d < 5; d++) {
      const night = addDays(NIGHT, d);
      for (let i = 1; i <= 4; i++) rows.push({ stay_date: night, booking_date: addDays(night, -10 - i), external_reservation_id: `${500 + d}-${i}` });
      rows.push({ stay_date: night, booking_date: addDays(night, -3), external_reservation_id: `${600 + d}` });
    }
    const streamed = new StayDateWindowsBuilder("bookings");
    let open: string | null = null;
    for (const row of rows) {
      if (open !== null && row.stay_date !== open) streamed.seal(open);
      open = row.stay_date;
      streamed.add(row);
    }
    expect(streamed.build()).toEqual(indexBookingRows(rows));
    expect(streamed.build().get(NIGHT)).toEqual({ n: 2, windows: [{ bw: 14, n: 1 }, { bw: 3, n: 1 }] });
  });
});

describe("StayDateWindowsBuilder with since: the bookings first seen after a fire", () => {
  const night = "2026-10-12";
  const noon = "2026-09-02T12:00:00.000Z";
  const row = (ext: string | null, bookedOn: string, createdAt: string | null): SlimReservationRow => ({
    stay_date: night,
    booking_date: bookedOn,
    external_reservation_id: ext,
    created_at: createdAt,
  });
  const rows: SlimReservationRow[] = [
    row("101", "2026-09-02", "2026-09-02T09:00:00.000Z"),
    row("102", "2026-09-02", "2026-09-02T12:00:00.000Z"),
    row("103", "2026-09-02", "2026-09-02T12:00:01.000Z"),
    row("104", "2026-09-03", "2026-09-03T08:00:00.000Z"),
    // A second room added after the fire to a booking that was there before it.
    row("6364686337417-1", "2026-09-02", "2026-09-02T10:00:00.000Z"),
    row("6364686337417-2", "2026-09-02", "2026-09-02T15:00:00.000Z"),
    // Both rooms after the fire, the second at a later booking date: one
    // booking at its earliest booking date.
    row("6364686337418-1", "2026-09-02", "2026-09-02T14:00:00.000Z"),
    row("6364686337418-2", "2026-09-03", "2026-09-03T09:00:00.000Z"),
    // No created_at: taken as already there.
    row("105", "2026-09-02", null),
  ];

  it("counts a booking only when its first row came after the instant, at its earliest booking date, and every booking without since", () => {
    expect(indexBookingRows(rows).get(night)).toEqual({ n: 7, windows: [{ bw: 40, n: 6 }, { bw: 39, n: 1 }] });
    const since = indexBookingRows(rows, noon).get(night)!;
    expect(since.n).toBe(3);
    expect(new Map(since.windows.map((w) => [w.bw, w.n]))).toEqual(new Map([[40, 2], [39, 1]]));
    // At the fire's own instant a row is not new; a moment later it is.
    expect(indexBookingRows(rows, "2026-09-02T12:00:01.000Z").get(night)!.n).toBe(2);
    expect(indexBookingRows(rows, "2026-09-02T11:59:59.000Z").get(night)!.n).toBe(4);
  });

  it("leaves out a date none of whose bookings are new, as the SQL gives it no row", () => {
    expect(indexBookingRows(rows, "2026-09-04T00:00:00.000Z").has(night)).toBe(false);
    expect(indexBookingRows(rows, "2026-09-04T00:00:00.000Z").size).toBe(0);
  });

  it("reads the same whether nights are sealed as they pass or all at the end", () => {
    const streaming = new StayDateWindowsBuilder("bookings", noon);
    for (const r of rows) streaming.add(r);
    streaming.seal(night);
    expect(streaming.build()).toEqual(indexBookingRows(rows, noon));
  });
});

describe("a past wedding in the comparables", () => {
  const AS_OF = "2026-05-17";
  const TARGET = "2026-06-06";
  const COMPARABLES = ["2025-06-07", "2025-05-31", "2025-06-14"];
  const selection = (): ComparableSelection => ({
    target: TARGET,
    comparables: COMPARABLES.map((date, i) => ({ date, tier: 1, reasons: [], score: 1 - i * 0.1 })),
    tier: 1,
    assumptions: { dayOfWeek: "Saturday", seasonLabel: "Summer", tiersTried: [1] },
  } as unknown as ComparableSelection);
  /** One ordinary booking a week, 14 to 40 days out, on every date. */
  const usual = (date: string): SlimReservationRow[] =>
    [14, 21, 28, 35].map((lead, i) => ({ stay_date: date, booking_date: addDays(date, -lead), external_reservation_id: `u${date}${i}` }));

  it("no longer inflates the expected pace, so the target is not read as slow against it", () => {
    const rows = [TARGET, ...COMPARABLES].flatMap(usual);
    // A 20-room wedding landed on the first comparable 20 days out.
    const wedding = Array.from({ length: 20 }, (_, i) => ({
      stay_date: COMPARABLES[0],
      booking_date: addDays(COMPARABLES[0], -20),
      external_reservation_id: `6364686337417-${i + 1}`,
    }));
    const obs = observeBookingSpeed({ rows: [...rows, ...wedding], target: TARGET, asOf: AS_OF, selection: selection(), windowDays: 7 });
    // The 14 to 20 day band: the usual one, plus the wedding as one booking.
    expect(obs.perComparable.map((c) => c.bookings)).toEqual([2, 1, 1]);
    expect(obs.expectedBookings).toBe(1.33);
    expect(obs.recentBookings).toBe(1);
    expect(obs.classification.speed).toBe("normal");
    // Counted as rooms it read 21 there, and the target as slower (the
    // strongest call three comparables allow).
    const asRooms = observeBookingSpeed({
      rows: [...rows, ...wedding].map((r) => ({ ...r, external_reservation_id: undefined })),
      target: TARGET,
      asOf: AS_OF,
      selection: selection(),
      windowDays: 7,
    });
    expect(asRooms.perComparable.map((c) => c.bookings)).toEqual([21, 1, 1]);
    expect(asRooms.expectedBookings).toBe(7.67);
    expect(asRooms.classification.speed).toBe("slower");
  });

  it("counts a wedding on the target once, so pace alone does not read it as a surge", () => {
    const rows = [TARGET, ...COMPARABLES].flatMap(usual);
    const wedding = Array.from({ length: 20 }, (_, i) => ({
      stay_date: TARGET,
      booking_date: AS_OF,
      external_reservation_id: `6364686337417-${i + 1}`,
    }));
    const obs = observeBookingSpeed({ rows: [...rows, ...wedding], target: TARGET, asOf: AS_OF, selection: selection(), windowDays: 7 });
    expect(obs.recentBookings).toBe(2);
    expect(obs.expectedBookings).toBe(1);
    expect(obs.classification.speed).toBe("normal");
  });

  it("reads the momentum fallback in bookings too", () => {
    const rows: SlimReservationRow[] = [];
    for (const offset of [-2, -1, 1, 2]) {
      const neighbor = addDays(TARGET, offset);
      const out = 20 + offset;
      const tag = `${offset < 0 ? "m" : "p"}${Math.abs(offset)}`;
      // This year: a 3-room reservation and a single, in the window. A year
      // ago: two singles.
      rows.push(...[1, 2, 3].map((i) => ({ stay_date: neighbor, booking_window_days: out + 1, external_reservation_id: `${700 + offset}-${i}` })));
      rows.push({ stay_date: neighbor, booking_window_days: out + 2, external_reservation_id: `S${tag}` });
      const prior = addDays(neighbor, -364);
      rows.push({ stay_date: prior, booking_window_days: out + 1, external_reservation_id: `P${tag}a` });
      rows.push({ stay_date: prior, booking_window_days: out + 3, external_reservation_id: `P${tag}b` });
    }
    const est = estimateMomentumFallback({ rows, target: TARGET, asOf: AS_OF, windowDays: 7 })!;
    for (const p of est.pairs) {
      expect(p.bookings).toBe(2);
      expect(p.yearAgoBookings).toBe(2);
    }
    expect(est.momentumRatio).toBe(1);
  });
});
