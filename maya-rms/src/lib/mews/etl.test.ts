import { describe, expect, it } from "vitest";
import {
  buildCategoryInventory,
  buildCategoryMap,
  buildRateLookup,
  detectFieldMap,
  enumerateStayNights,
  findReservationsList,
  parseMewsApiResponse,
} from "@/lib/mews/etl";

describe("mews etl", () => {
  const sampleReservation = {
    Id: "res_123",
    State: "Confirmed",
    ArrivalDate: "2025-05-01T14:00:00Z",
    DepartureDate: "2025-05-03T10:00:00Z",
    CreatedUtc: "2025-04-15T09:30:00Z",
    SpaceCategoryId: "room_1",
    StayPriceIncludingTaxes: { Value: "150.00" },
  };

  const sampleResponse = {
    Reservations: [sampleReservation],
    SpaceCategories: [{ Id: "room_1", Name: "Medium" }],
  };

  it("detectFieldMap picks Mews-style fields", () => {
    const f = detectFieldMap(sampleReservation as Record<string, unknown>);
    expect(f.reservation_id).toBe("Id");
    expect(f.stay_date).toBe("ArrivalDate");
    expect(f.booking_date).toBe("CreatedUtc");
    expect(f.room_type_id).toBe("SpaceCategoryId");
    expect(f.rate).toBe("StayPriceIncludingTaxes");
  });

  it("buildCategoryMap maps category ids to names", () => {
    const m = buildCategoryMap(sampleResponse as Record<string, unknown>);
    expect(m.room_1).toBe("Medium");
  });

  it("buildCategoryInventory uses RoomCount when present", () => {
    const data = {
      Reservations: [sampleReservation],
      SpaceCategories: [{ Id: "room_1", Name: "Medium", RoomCount: 22 }],
    };
    const inv = buildCategoryInventory(data as Record<string, unknown>, 100);
    expect(inv.room_1?.name).toBe("Medium");
    expect(inv.room_1?.total_rooms).toBe(22);
  });

  it("buildCategoryInventory falls back to hotel default when no count field", () => {
    const inv = buildCategoryInventory(sampleResponse as Record<string, unknown>, 77);
    expect(inv.room_1?.total_rooms).toBe(77);
  });

  it("enumerateStayNights uses exclusive departure", () => {
    const f = detectFieldMap(sampleReservation as Record<string, unknown>);
    const { nights } = enumerateStayNights(sampleReservation as Record<string, unknown>, f);
    expect(nights).toEqual(["2025-05-01", "2025-05-02"]);
  });

  it("enumerateStayNights same-day arrival and departure is one night", () => {
    const oneNight = {
      ...sampleReservation,
      ArrivalDate: "2025-05-01T14:00:00Z",
      DepartureDate: "2025-05-01T10:00:00Z",
    };
    const f = detectFieldMap(oneNight as Record<string, unknown>);
    const { nights } = enumerateStayNights(oneNight as Record<string, unknown>, f);
    expect(nights).toEqual(["2025-05-01"]);
  });

  it("parseMewsApiResponse expands nights and splits rate", () => {
    const { roomTypes, reservations, stats, canceledExternalIds } = parseMewsApiResponse(
      sampleResponse as Record<string, unknown>,
    );
    expect(roomTypes).toHaveLength(1);
    expect(roomTypes[0].external_room_type_id).toBe("room_1");
    expect(reservations).toHaveLength(2);
    expect(reservations.every((r) => r.external_reservation_id === "res_123")).toBe(true);
    expect(reservations[0].current_rate).toBe(75);
    expect(reservations[1].current_rate).toBe(75);
    expect(stats.skippedMissingReservationId).toBe(0);
    expect(stats.skippedNoStayNights).toBe(0);
    expect(stats.duplicateStayNightKeysMerged).toBe(0);
    expect(stats.rowsWithMissingRate).toBe(0);
    expect(stats.skippedCanceled).toBe(0);
    expect(canceledExternalIds).toHaveLength(0);
  });

  it("parseMewsApiResponse stamps each night's own booking window", () => {
    const { reservations } = parseMewsApiResponse(sampleResponse as Record<string, unknown>);
    const byNight = Object.fromEntries(
      reservations.map((r) => [r.stay_date, r.booking_window_days]),
    );
    // Booked 2025-04-15: night 1 is 16 days out, night 2 is 17 — never the
    // arrival window stamped on both.
    expect(byNight).toEqual({ "2025-05-01": 16, "2025-05-02": 17 });
  });

  it("parseMewsApiResponse skips canceled reservations and lists their ids", () => {
    const canceled = {
      ...sampleReservation,
      Id: "res_canceled",
      State: "Canceled",
    };
    const { reservations, stats, canceledExternalIds } = parseMewsApiResponse({
      Reservations: [canceled],
      SpaceCategories: [{ Id: "room_1", Name: "Medium" }],
    } as Record<string, unknown>);
    expect(reservations).toHaveLength(0);
    expect(stats.skippedCanceled).toBe(1);
    expect(canceledExternalIds).toEqual(["res_canceled"]);
  });

  it("parseMewsApiResponse skips rows without reservation id", () => {
    const { reservations, stats } = parseMewsApiResponse({
      Reservations: [{ ArrivalDate: "2025-05-01T00:00:00Z" }],
      SpaceCategories: [],
    } as Record<string, unknown>);
    expect(reservations).toHaveLength(0);
    expect(stats.skippedMissingReservationId).toBe(1);
  });

  it("parseMewsApiResponse skips when arrival cannot be parsed into nights", () => {
    const { reservations, stats } = parseMewsApiResponse({
      Reservations: [{ Id: "x", ArrivalDate: "not-a-date" }],
      SpaceCategories: [],
    } as Record<string, unknown>);
    expect(reservations).toHaveLength(0);
    expect(stats.skippedNoStayNights).toBe(1);
  });

  it("parseMewsApiResponse skips an ambiguous non-ISO date rather than guessing", () => {
    // 05/01/2025 is May 1 to a US PMS and Jan 5 to a European one. Mews only ever
    // sends ISO 8601, and `new Date` would silently pick one — in the machine's
    // timezone, so the answer depended on where the edge function ran.
    const { reservations, stats } = parseMewsApiResponse({
      Reservations: [{ Id: "x", ArrivalDate: "05/01/2025" }],
      SpaceCategories: [],
    } as Record<string, unknown>);
    expect(reservations).toHaveLength(0);
    expect(stats.skippedNoStayNights).toBe(1);
  });

  it("parseMewsApiResponse merges duplicate reservation+night from merged API chunks", () => {
    const { reservations, stats } = parseMewsApiResponse({
      Reservations: [sampleReservation, sampleReservation],
      SpaceCategories: [{ Id: "room_1", Name: "Medium" }],
    } as Record<string, unknown>);
    expect(reservations).toHaveLength(2);
    expect(stats.duplicateStayNightKeysMerged).toBe(2);
  });

  it("parseMewsApiResponse counts rows with no resolvable rate", () => {
    const noRate = {
      Id: "res_999",
      State: "Confirmed",
      ArrivalDate: "2025-05-01T14:00:00Z",
      DepartureDate: "2025-05-02T10:00:00Z",
      CreatedUtc: "2025-04-15T09:30:00Z",
      SpaceCategoryId: "room_1",
    };
    const { reservations, stats } = parseMewsApiResponse({
      Reservations: [noRate],
      SpaceCategories: [{ Id: "room_1", Name: "Medium" }],
    } as Record<string, unknown>);
    expect(reservations).toHaveLength(1);
    expect(reservations[0].current_rate).toBeNull();
    expect(stats.rowsWithMissingRate).toBe(1);
  });

  it("buildRateLookup sums Items by OrderId", () => {
    const data = {
      Reservations: [{ Id: "o1" }],
      Items: [
        { OrderId: "o1", Amount: { GrossValue: 40 } },
        { OrderId: "o1", Amount: { Value: 10 } },
      ],
    };
    const map = buildRateLookup(data as Record<string, unknown>);
    expect(map.o1).toBe(50);
  });

  describe("stays spanning fetch-window boundaries", () => {
    // reservations/getAll is called per 96h window and returns any colliding
    // stay — with its whole order — in each window, then the chunks are
    // concatenated. This is the payload a 4-night stay across one boundary
    // produces: the reservation twice, its four nightly items twice.
    const spanning = {
      Id: "res_span",
      State: "Confirmed",
      ScheduledStartUtc: "2026-08-05T14:00:00Z",
      ScheduledEndUtc: "2026-08-09T10:00:00Z",
      CreatedUtc: "2026-07-01T09:00:00Z",
      SpaceCategoryId: "room_1",
    };
    const nightlyItems = [1, 2, 3, 4].map((n) => ({
      Id: `item_${n}`,
      OrderId: "res_span",
      Amount: { GrossValue: 100 },
    }));
    const mergedPayload = {
      Reservations: [spanning, spanning],
      Items: [...nightlyItems, ...nightlyItems],
      SpaceCategories: [{ Id: "room_1", Name: "Medium" }],
    };

    it("buildRateLookup counts each order item once", () => {
      const map = buildRateLookup(mergedPayload as Record<string, unknown>);
      expect(map.res_span).toBe(400);
    });

    it("parseMewsApiResponse does not double the nightly rate", () => {
      const { reservations, stats } = parseMewsApiResponse(
        mergedPayload as Record<string, unknown>,
      );
      expect(reservations).toHaveLength(4);
      expect(reservations.map((r) => r.current_rate)).toEqual([100, 100, 100, 100]);
      expect(stats.duplicateStayNightKeysMerged).toBe(4);
      expect(stats.rowsWithMissingRate).toBe(0);
    });

    it("dedupes items whose Id is a number rather than a GUID string", () => {
      const numericItems = [1, 2, 3, 4].map((n) => ({
        Id: n,
        OrderId: "res_span",
        Amount: { GrossValue: 100 },
      }));
      const data = {
        ...mergedPayload,
        Items: [...numericItems, ...numericItems],
      };
      expect(buildRateLookup(data as Record<string, unknown>).res_span).toBe(400);
      const { reservations } = parseMewsApiResponse(data as Record<string, unknown>);
      expect(reservations.map((r) => r.current_rate)).toEqual([100, 100, 100, 100]);
    });
  });

  describe("hotel-local stay nights", () => {
    // Real reservations/getAll has no ArrivalDate — it returns UTC instants that
    // already fold in the local check-in time.
    const laReservation = {
      Id: "res_la",
      State: "Confirmed",
      ScheduledStartUtc: "2026-08-02T00:00:00Z", // Aug 1, 17:00 PDT
      ScheduledEndUtc: "2026-08-04T18:00:00Z", // Aug 4, 11:00 PDT
      CreatedUtc: "2026-07-25T02:00:00Z", // Jul 24, 19:00 PDT
      SpaceCategoryId: "room_1",
    };

    it("detectFieldMap falls through to ScheduledStartUtc with no direct rate field", () => {
      const f = detectFieldMap(laReservation as Record<string, unknown>);
      expect(f.stay_date).toBe("ScheduledStartUtc");
      expect(f.rate).toBeNull();
    });

    it("keeps the arrival night for a hotel west of UTC", () => {
      const f = detectFieldMap(laReservation as Record<string, unknown>);
      const { nights } = enumerateStayNights(
        laReservation as Record<string, unknown>,
        f,
        "America/Los_Angeles",
      );
      expect(nights).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);
    });

    it("puts a Honolulu one-night stay on its own local date", () => {
      const hnl = {
        ...laReservation,
        ScheduledStartUtc: "2026-08-02T01:00:00Z", // Aug 1, 15:00 HST
        ScheduledEndUtc: "2026-08-02T21:00:00Z", // Aug 2, 11:00 HST
      };
      const f = detectFieldMap(hnl as Record<string, unknown>);
      const { nights } = enumerateStayNights(
        hnl as Record<string, unknown>,
        f,
        "Pacific/Honolulu",
      );
      expect(nights).toEqual(["2026-08-01"]);
    });

    it("leaves a hotel east of UTC alone", () => {
      const ams = {
        ...laReservation,
        ScheduledStartUtc: "2026-08-01T14:00:00Z",
        ScheduledEndUtc: "2026-08-03T09:00:00Z",
      };
      const f = detectFieldMap(ams as Record<string, unknown>);
      const { nights } = enumerateStayNights(
        ams as Record<string, unknown>,
        f,
        "Europe/Amsterdam",
      );
      expect(nights).toEqual(["2026-08-01", "2026-08-02"]);
    });

    it("does not shift a date-only arrival into the previous day", () => {
      const dateOnly = {
        ...sampleReservation,
        ArrivalDate: "2025-05-01",
        DepartureDate: "2025-05-03",
      };
      const f = detectFieldMap(dateOnly as Record<string, unknown>);
      const { nights } = enumerateStayNights(
        dateOnly as Record<string, unknown>,
        f,
        "America/Los_Angeles",
      );
      expect(nights).toEqual(["2025-05-01", "2025-05-02"]);
    });

    it("does not shift a calendar date that was serialized as UTC midnight", () => {
      // Only the `…Utc` names promise an instant; ArrivalDate is a civil day, and
      // converting one lands a west-of-Greenwich stay on the previous date.
      const utcMidnight = {
        ...sampleReservation,
        ArrivalDate: "2025-05-01T00:00:00Z",
        DepartureDate: "2025-05-03T00:00:00Z",
      };
      const f = detectFieldMap(utcMidnight as Record<string, unknown>);
      const { nights } = enumerateStayNights(
        utcMidnight as Record<string, unknown>,
        f,
        "America/Los_Angeles",
      );
      expect(nights).toEqual(["2025-05-01", "2025-05-02"]);
    });

    it("falls back to UTC when the hotel timezone is unusable", () => {
      const f = detectFieldMap(laReservation as Record<string, unknown>);
      const { nights } = enumerateStayNights(
        laReservation as Record<string, unknown>,
        f,
        "Mars/Olympus_Mons",
      );
      expect(nights).toEqual(["2026-08-02", "2026-08-03"]);
    });

    it("parseMewsApiResponse splits the stay total across local nights", () => {
      const { reservations } = parseMewsApiResponse(
        {
          Reservations: [laReservation],
          Items: [1, 2, 3].map((n) => ({
            Id: `item_${n}`,
            OrderId: "res_la",
            Amount: { GrossValue: 100 },
          })),
          SpaceCategories: [{ Id: "room_1", Name: "Medium" }],
        } as Record<string, unknown>,
        { hotelTimeZone: "America/Los_Angeles" },
      );
      // 300 total over three real nights, not 150 over two, and lead times run
      // off the local booking date (Jul 24 PDT, not Jul 25 UTC).
      expect(
        reservations.map((r) => [r.stay_date, r.current_rate, r.booking_window_days]),
      ).toEqual([
        ["2026-08-01", 100, 8],
        ["2026-08-02", 100, 9],
        ["2026-08-03", 100, 10],
      ]);
    });

    it("builds one date formatter per timezone, not one per reservation", () => {
      const data = {
        Reservations: Array.from({ length: 40 }, (_, i) => ({
          ...laReservation,
          Id: `res_${i}`,
        })),
        SpaceCategories: [{ Id: "room_1", Name: "Medium" }],
      };
      const real = Intl.DateTimeFormat;
      let built = 0;
      const counting = function (...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
        built += 1;
        return new real(...args);
      };
      Intl.DateTimeFormat = counting as unknown as typeof Intl.DateTimeFormat;
      let rows = 0;
      try {
        rows = parseMewsApiResponse(data as Record<string, unknown>, {
          hotelTimeZone: "Asia/Tokyo",
        }).reservations.length;
      } finally {
        Intl.DateTimeFormat = real;
      }
      expect(rows).toBe(120);
      // Edge functions bill CPU per invocation and the fleet cron parses every
      // Mews hotel in one, so this cannot scale with the reservation count.
      expect(built).toBeLessThanOrEqual(2);
    });
  });

  it("findReservationsList prefers Reservations key", () => {
    const list = findReservationsList(sampleResponse as Record<string, unknown>);
    expect(list).toHaveLength(1);
  });
});
