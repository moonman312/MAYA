import { describe, expect, it } from "vitest";
import {
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

  it("enumerateStayNights uses exclusive departure", () => {
    const f = detectFieldMap(sampleReservation as Record<string, unknown>);
    const { nights } = enumerateStayNights(sampleReservation as Record<string, unknown>, f);
    expect(nights).toEqual(["2025-05-01", "2025-05-02"]);
  });

  it("parseMewsApiResponse expands nights and splits rate", () => {
    const { roomTypes, reservations } = parseMewsApiResponse(sampleResponse as Record<string, unknown>);
    expect(roomTypes).toHaveLength(1);
    expect(roomTypes[0].external_room_type_id).toBe("room_1");
    expect(reservations).toHaveLength(2);
    expect(reservations.every((r) => r.external_reservation_id === "res_123")).toBe(true);
    expect(reservations[0].current_rate).toBe(75);
    expect(reservations[1].current_rate).toBe(75);
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

  it("findReservationsList prefers Reservations key", () => {
    const list = findReservationsList(sampleResponse as Record<string, unknown>);
    expect(list).toHaveLength(1);
  });
});
