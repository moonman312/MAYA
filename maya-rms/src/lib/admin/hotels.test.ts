/**
 * A hotel staff create by hand gets a time zone the runtime knows, or none
 * at all: a name it does not know is read as UTC everywhere MAYA dates a
 * night, with no message (audit A19).
 */
import { describe, expect, it } from "vitest";
import { createHotel, isKnownTimeZone } from "./hotels";
import { fakeSupabase } from "../engine/fake-supabase.test";

describe("isKnownTimeZone", () => {
  it("knows real zone names and nothing else", () => {
    expect(isKnownTimeZone("America/Chicago")).toBe(true);
    expect(isKnownTimeZone("Europe/Lisbon")).toBe(true);
    expect(isKnownTimeZone("UTC")).toBe(true);
    expect(isKnownTimeZone("America/Chicagoo")).toBe(false);
    expect(isKnownTimeZone("Central")).toBe(false);
    expect(isKnownTimeZone("")).toBe(false);
    expect(isKnownTimeZone(null)).toBe(false);
  });
});

describe("createHotel", () => {
  it("refuses a zone name the runtime does not know, before anything is written", async () => {
    const db = fakeSupabase({ hotels: [], hotel_settings: [] });
    await expect(
      createHotel(db.client, { name: "Juniper Lodge", timezone: "America/Chicagoo", currency: "USD", total_rooms_per_type: 10 }),
    ).rejects.toThrow('"America/Chicagoo" is not a time zone name. Use one like America/Chicago.');
    expect(db.tables.hotels).toEqual([]);
  });

  it("creates the hotel with a real one", async () => {
    const db = fakeSupabase({ hotels: [], hotel_settings: [] });
    const { hotelId } = await createHotel(db.client, { name: "Juniper Lodge", timezone: "America/Chicago", currency: "USD", total_rooms_per_type: 10 });
    expect(db.tables.hotels).toEqual([expect.objectContaining({ id: hotelId, timezone: "America/Chicago" })]);
  });
});
