import { describe, expect, it } from "vitest";
import {
  isThinkRoomCharge,
  parseThinkReservations,
  parseThinkRoomTypes,
  redactThinkPayload,
} from "@/lib/think/etl";

const UTC = { hotelTimeZone: "UTC" };

/** A room-night charge as the spec's LineItem shape spells it. */
const roomLine = (
  bookingId: string,
  billedOn: string | null,
  amount: number,
  extra: Record<string, unknown> = {},
) => ({
  id: `li_${bookingId}_${billedOn ?? "summary"}_${amount}`,
  bookingId,
  billingType: "RoomLineItem",
  ...(billedOn ? { billingDate: `${billedOn}T12:00:00Z` } : {}),
  amount,
  ...extra,
});

describe("think etl", () => {
  const sampleReservation = {
    id: "res_1",
    confirmationId: "ABC123",
    status: "scheduled",
    channel: "website",
    createdAt: "2026-05-15T18:00:00Z",
    updatedAt: "2026-05-16T09:00:00Z",
    customer: { firstName: "Jane", lastName: "Doe", emailAddress: "jane@example.com" },
    additionalGuestNames: "John Doe",
    dietaryRestrictions: "Vegetarian, no nuts",
    specialAccommodations: "Ground floor room",
    arrivalTime: "15:00",
    subTotal: 320,
    taxes: 32,
    total: 352,
    bookings: [
      {
        id: "book_1",
        roomTypeId: "rt_king",
        rateTypeId: "rate_bar",
        startDate: "2026-06-01",
        endDate: "2026-06-03",
        status: "scheduled",
        numberOfGuests: 2,
        numberOfAdults: 2,
        numberOfChildren: 0,
        customerGroup: "AAA",
      },
    ],
    lineItems: [
      roomLine("book_1", "2026-06-01", 150, { customerName: "Jane Doe" }),
      roomLine("book_1", "2026-06-02", 170, { customerName: "Jane Doe" }),
      {
        id: "li_pet",
        bookingId: "book_1",
        billingType: "PetLineItem",
        billingDate: "2026-06-01T12:00:00Z",
        amount: 40,
      },
    ],
  };

  it("keys a single-booking reservation by reservation and booking id", () => {
    // Composite even with one booking — a bare key would flip to composite
    // the moment a second room is added, orphaning the old rows.
    const { rows, stats, canceledExternalIds } = parseThinkReservations(
      [sampleReservation],
      UTC,
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.external_reservation_id === "res_1:book_1")).toBe(true);
    expect(rows.map((r) => r.stay_date)).toEqual(["2026-06-01", "2026-06-02"]);
    expect(rows.every((r) => r.external_room_type_id === "rt_king")).toBe(true);
    expect(stats.skippedMissingReservationId).toBe(0);
    expect(stats.skippedNoStayNights).toBe(0);
    expect(stats.skippedCanceled).toBe(0);
    expect(canceledExternalIds).toHaveLength(0);
  });

  it("prices each night from its own room line item, ignoring pet fees", () => {
    const { rows, stats } = parseThinkReservations([sampleReservation], UTC);
    expect(rows.map((r) => r.current_rate)).toEqual([150, 170]);
    expect(stats.rowsWithMissingRate).toBe(0);
  });

  it("explodes a multi-booking reservation into per-room room-nights", () => {
    const multi = {
      id: "res_multi",
      status: "scheduled",
      createdAt: "2026-05-01T12:00:00Z",
      bookings: [
        {
          id: "b1",
          roomTypeId: "rt_king",
          startDate: "2026-06-01",
          endDate: "2026-06-03",
          status: "scheduled",
        },
        {
          id: "b2",
          roomTypeId: "rt_queen",
          startDate: "2026-06-01",
          endDate: "2026-06-02",
          status: "scheduled",
        },
      ],
      lineItems: [
        roomLine("b1", "2026-06-01", 200),
        roomLine("b1", "2026-06-02", 200),
        roomLine("b2", "2026-06-01", 120),
      ],
    };
    const { rows } = parseThinkReservations([multi], UTC);
    expect(
      rows.map((r) => [r.external_reservation_id, r.external_room_type_id, r.stay_date, r.current_rate]),
    ).toEqual([
      ["res_multi:b1", "rt_king", "2026-06-01", 200],
      ["res_multi:b1", "rt_king", "2026-06-02", 200],
      ["res_multi:b2", "rt_queen", "2026-06-01", 120],
    ]);
  });

  it("splits a summary room line evenly across the booking's nights", () => {
    const summary = {
      ...sampleReservation,
      id: "res_summary",
      lineItems: [roomLine("book_1", null, 301)],
    };
    const { rows, stats } = parseThinkReservations([summary], UTC);
    expect(rows.map((r) => r.current_rate)).toEqual([150.5, 150.5]);
    expect(stats.rowsWithMissingRate).toBe(0);
  });

  it("prefers actualAmount over the pre-discount amount", () => {
    const discounted = {
      ...sampleReservation,
      id: "res_disc",
      lineItems: [
        roomLine("book_1", "2026-06-01", 200, { actualAmount: 180 }),
        roomLine("book_1", "2026-06-02", 200, { actualAmount: 180 }),
      ],
    };
    const { rows } = parseThinkReservations([discounted], UTC);
    expect(rows.map((r) => r.current_rate)).toEqual([180, 180]);
  });

  it("ignores voided line items entirely", () => {
    const voided = {
      ...sampleReservation,
      id: "res_void",
      lineItems: [
        roomLine("book_1", "2026-06-01", 150),
        roomLine("book_1", "2026-06-01", 999, { canceled: true }),
        roomLine("book_1", "2026-06-02", 170),
      ],
    };
    const { rows } = parseThinkReservations([voided], UTC);
    expect(rows.map((r) => r.current_rate)).toEqual([150, 170]);
  });

  it("does not let one booking's charges price another's nights", () => {
    const crossed = {
      id: "res_cross",
      status: "scheduled",
      createdAt: "2026-05-01T12:00:00Z",
      bookings: [
        { id: "b1", roomTypeId: "rt_king", startDate: "2026-06-01", endDate: "2026-06-02" },
        { id: "b2", roomTypeId: "rt_queen", startDate: "2026-06-01", endDate: "2026-06-02" },
      ],
      lineItems: [roomLine("b1", "2026-06-01", 200)],
    };
    const { rows, stats } = parseThinkReservations([crossed], UTC);
    const byId = Object.fromEntries(rows.map((r) => [r.external_reservation_id, r.current_rate]));
    expect(byId["res_cross:b1"]).toBe(200);
    expect(byId["res_cross:b2"]).toBeNull();
    expect(stats.rowsWithMissingRate).toBe(1);
  });

  it("attributes a bookingId-less room line to a lone booking", () => {
    const loose = {
      ...sampleReservation,
      id: "res_loose",
      lineItems: [{ id: "li_x", billingType: "RoomLineItem", amount: 300 }],
    };
    const { rows } = parseThinkReservations([loose], UTC);
    expect(rows.map((r) => r.current_rate)).toEqual([150, 150]);
  });

  it("reads the booking's own lineItems when the reservation carries none", () => {
    const nested = {
      id: "res_nested",
      status: "scheduled",
      createdAt: "2026-05-01T12:00:00Z",
      bookings: [
        {
          id: "b1",
          roomTypeId: "rt_king",
          startDate: "2026-06-01",
          endDate: "2026-06-03",
          lineItems: [
            roomLine("b1", "2026-06-01", 110),
            roomLine("b1", "2026-06-02", 130),
          ],
        },
      ],
    };
    const { rows } = parseThinkReservations([nested], UTC);
    expect(rows.map((r) => r.current_rate)).toEqual([110, 130]);
  });

  it("accepts an id-less summary line on a booking's own list even when multi-booking", () => {
    const nested = {
      id: "res_scoped",
      status: "scheduled",
      createdAt: "2026-05-01T12:00:00Z",
      bookings: [
        {
          id: "b1",
          roomTypeId: "rt_king",
          startDate: "2026-06-01",
          endDate: "2026-06-03",
          lineItems: [{ id: "li_a", billingType: "RoomLineItem", amount: 200 }],
        },
        {
          id: "b2",
          roomTypeId: "rt_queen",
          startDate: "2026-06-01",
          endDate: "2026-06-02",
          lineItems: [{ id: "li_b", billingType: "RoomLineItem", amount: 130 }],
        },
      ],
    };
    const { rows } = parseThinkReservations([nested], UTC);
    const byId = Object.fromEntries(rows.map((r) => [r.external_reservation_id, r.current_rate]));
    expect(byId["res_scoped:b1"]).toBe(100);
    expect(byId["res_scoped:b2"]).toBe(130);
  });

  it("counts rows with nothing rate-like at all", () => {
    const noRate = {
      ...sampleReservation,
      id: "res_norate",
      lineItems: [
        {
          id: "li_pet",
          bookingId: "book_1",
          billingType: "PetLineItem",
          billingDate: "2026-06-01T12:00:00Z",
          amount: 40,
        },
      ],
    };
    const { rows, stats } = parseThinkReservations([noRate], UTC);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.current_rate === null)).toBe(true);
    expect(stats.rowsWithMissingRate).toBe(2);
  });

  it("excludes a canceled reservation and surfaces both keyings of its ids", () => {
    const canceled = {
      ...sampleReservation,
      id: "res_c",
      status: "canceled",
      canceledAt: "2026-05-20T10:00:00Z",
      bookings: [
        { id: "b1", roomTypeId: "rt_king", startDate: "2026-06-01", endDate: "2026-06-03" },
        { id: "b2", roomTypeId: "rt_queen", startDate: "2026-06-01", endDate: "2026-06-02" },
      ],
    };
    const { rows, stats, canceledExternalIds } = parseThinkReservations([canceled], UTC);
    expect(rows).toHaveLength(0);
    expect(stats.skippedCanceled).toBe(1);
    expect([...canceledExternalIds].sort()).toEqual(["res_c", "res_c:b1", "res_c:b2"]);
  });

  it("treats no_show like canceled", () => {
    const noShow = { ...sampleReservation, id: "res_ns", status: "no_show" };
    const { rows, canceledExternalIds } = parseThinkReservations([noShow], UTC);
    expect(rows).toHaveLength(0);
    expect(canceledExternalIds).toContain("res_ns");
  });

  it("drops a canceled booking inside an active reservation but keeps the rest", () => {
    const partial = {
      id: "res_p",
      status: "scheduled",
      createdAt: "2026-05-01T12:00:00Z",
      bookings: [
        {
          id: "b1",
          roomTypeId: "rt_king",
          startDate: "2026-06-01",
          endDate: "2026-06-02",
          status: "scheduled",
        },
        {
          id: "b2",
          roomTypeId: "rt_queen",
          startDate: "2026-06-01",
          endDate: "2026-06-02",
          status: "canceled",
        },
      ],
      lineItems: [roomLine("b1", "2026-06-01", 200)],
    };
    const { rows, stats, canceledExternalIds } = parseThinkReservations([partial], UTC);
    expect(rows.map((r) => r.external_reservation_id)).toEqual(["res_p:b1"]);
    expect(stats.skippedCanceled).toBe(1);
    // The bare id rides along because rows synced while this was the only
    // booking are keyed by it; the surviving booking's key must not.
    expect([...canceledExternalIds].sort()).toEqual(["res_p", "res_p:b2"]);
  });

  it("stamps each night's own booking window", () => {
    const { rows } = parseThinkReservations([sampleReservation], UTC);
    const byNight = Object.fromEntries(rows.map((r) => [r.stay_date, r.booking_window_days]));
    // Booked May 15: night 1 is 17 days out, night 2 is 18 — never the
    // check-in window stamped on both.
    expect(byNight).toEqual({ "2026-06-01": 17, "2026-06-02": 18 });
  });

  it("folds createdAt onto the hotel's calendar before computing windows", () => {
    const evening = {
      ...sampleReservation,
      id: "res_pdt",
      createdAt: "2026-05-16T02:00:00Z", // May 15, 19:00 PDT
    };
    const { rows } = parseThinkReservations([evening], {
      hotelTimeZone: "America/Los_Angeles",
    });
    expect(rows[0].booking_date).toBe("2026-05-15");
    expect(rows.map((r) => r.booking_window_days)).toEqual([17, 18]);
  });

  it("folds billingDate instants onto the hotel's calendar when matching nights", () => {
    const lateBilled = {
      ...sampleReservation,
      id: "res_late",
      lineItems: [
        roomLine("book_1", null, 150, { billingDate: "2026-06-02T03:59:00Z" }), // Jun 1, 23:59 EDT
        roomLine("book_1", null, 170, { billingDate: "2026-06-03T01:00:00Z" }), // Jun 2, 21:00 EDT
      ],
    };
    const { rows } = parseThinkReservations([lateBilled], {
      hotelTimeZone: "America/New_York",
    });
    // Truncated in UTC these would land on Jun 2 and Jun 3 — the second one
    // off the stay entirely — and both nights would fall to the even split.
    expect(rows.map((r) => [r.stay_date, r.current_rate])).toEqual([
      ["2026-06-01", 150],
      ["2026-06-02", 170],
    ]);
  });

  it("merges duplicate reservation+night keys from merged pages", () => {
    const { rows, stats } = parseThinkReservations(
      [sampleReservation, sampleReservation],
      UTC,
    );
    expect(rows).toHaveLength(2);
    expect(stats.duplicateStayNightKeysMerged).toBe(2);
  });

  it("skips entries without a reservation id", () => {
    const { rows, stats } = parseThinkReservations([{}, null], UTC);
    expect(rows).toHaveLength(0);
    expect(stats.skippedMissingReservationId).toBe(2);
  });

  it("counts a reservation with no bookings as having no stay nights", () => {
    const { rows, stats } = parseThinkReservations([{ id: "res_nb", status: "scheduled" }], UTC);
    expect(rows).toHaveLength(0);
    expect(stats.skippedNoStayNights).toBe(1);
  });

  it("skips a booking whose start date cannot be read", () => {
    const junk = {
      id: "res_junk",
      status: "scheduled",
      bookings: [{ id: "b1", startDate: "not-a-date" }],
    };
    const { rows, stats } = parseThinkReservations([junk], UTC);
    expect(rows).toHaveLength(0);
    expect(stats.skippedNoStayNights).toBe(1);
  });

  it("treats same-day start and end as a single night", () => {
    const dayUse = {
      id: "res_day",
      status: "scheduled",
      bookings: [
        { id: "b1", roomTypeId: "rt_king", startDate: "2026-06-01", endDate: "2026-06-01" },
      ],
    };
    const { rows } = parseThinkReservations([dayUse], UTC);
    expect(rows.map((r) => r.stay_date)).toEqual(["2026-06-01"]);
  });

  describe("raw_payload redaction", () => {
    it("strips every guest-identifying field from the stored payload", () => {
      const { rows } = parseThinkReservations([sampleReservation], UTC);
      const payload = rows[0].raw_payload as Record<string, unknown>;
      expect(payload._redacted).toBe(true);
      expect(payload).not.toHaveProperty("customer");
      expect(payload).not.toHaveProperty("additionalGuestNames");
      expect(payload).not.toHaveProperty("dietaryRestrictions");
      expect(payload).not.toHaveProperty("specialAccommodations");
      expect(payload).not.toHaveProperty("arrivalTime");
      // Line items carry a customerName, so none of them may survive either.
      expect(payload).not.toHaveProperty("lineItems");
      expect(payload).not.toHaveProperty("bookings");
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain("Jane");
      expect(serialized).not.toContain("Vegetarian");
      expect(serialized).not.toContain("Ground floor");
    });

    it("keeps only booking structure, counts, channel, and totals", () => {
      const payload = redactThinkPayload(
        sampleReservation as unknown as Record<string, unknown>,
        sampleReservation.bookings[0] as unknown as Record<string, unknown>,
      );
      expect(payload.id).toBe("res_1");
      expect(payload.confirmationId).toBe("ABC123");
      expect(payload.channel).toBe("website");
      expect(payload.totals).toEqual({ subTotal: 320, taxes: 32, total: 352 });
      const booking = payload.booking as Record<string, unknown>;
      expect(booking.id).toBe("book_1");
      expect(booking.roomTypeId).toBe("rt_king");
      expect(booking.startDate).toBe("2026-06-01");
      expect(booking.numberOfAdults).toBe(2);
      expect(booking).not.toHaveProperty("customerGroup");
    });
  });

  describe("parseThinkRoomTypes", () => {
    it("maps ids and names, skipping entries without an id", () => {
      const types = parseThinkRoomTypes(
        [{ id: "rt_king", name: "Deluxe King" }, { name: "orphan" }, null],
        12,
      );
      expect(types).toEqual([
        {
          external_room_type_id: "rt_king",
          name: "Deluxe King",
          display_name: "Deluxe King",
          total_rooms: 12,
        },
      ]);
    });
  });

  describe("isThinkRoomCharge", () => {
    it("accepts the spec's schema-name discriminator and plain spellings", () => {
      expect(isThinkRoomCharge({ billingType: "RoomLineItem" })).toBe(true);
      expect(isThinkRoomCharge({ billingType: "room" })).toBe(true);
      expect(isThinkRoomCharge({ billingType: "ROOM_CHARGE" })).toBe(true);
    });

    it("rejects other line item kinds and missing discriminators", () => {
      expect(isThinkRoomCharge({ billingType: "PetLineItem" })).toBe(false);
      expect(isThinkRoomCharge({ billingType: "AdditionalGuestLineItem" })).toBe(false);
      expect(isThinkRoomCharge({})).toBe(false);
    });
  });
});
