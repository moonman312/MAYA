/**
 * A property's business numbers for the Command Center: read under the
 * caller's session from staff_hotel_business_numbers, and added up over a
 * range the way each night is.
 */
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { businessByMonth, businessTotals, loadBusinessNumbers } from "./business-numbers";

function client(result: { data: unknown; error: { message: string } | null }, calls: unknown[] = []): SupabaseClient {
  return { rpc: async (name: string, args: unknown) => (calls.push([name, args]), result) } as unknown as SupabaseClient;
}

describe("loadBusinessNumbers", () => {
  it("asks for the property and range, and reads numbers that arrive as text", async () => {
    const calls: unknown[] = [];
    const nights = await loadBusinessNumbers(
      client(
        {
          data: [
            { stay_date: "2026-10-01", rooms_sold: 4, rooms_available: 10, occupancy_pct: "40.0", room_revenue: "660.00", adr: "152.50" },
            { stay_date: "2026-10-02", rooms_sold: 0, rooms_available: 12, occupancy_pct: "0.0", room_revenue: "0.00", adr: null },
          ],
          error: null,
        },
        calls,
      ),
      "h1",
      "2026-10-01",
      "2026-10-02",
    );
    expect(calls).toEqual([["staff_hotel_business_numbers", { p_hotel_id: "h1", p_from: "2026-10-01", p_to: "2026-10-02" }]]);
    expect(nights).toEqual([
      { stayDate: "2026-10-01", roomsSold: 4, roomsAvailable: 10, occupancyPct: 40, roomRevenue: 660, adr: 152.5 },
      { stayDate: "2026-10-02", roomsSold: 0, roomsAvailable: 12, occupancyPct: 0, roomRevenue: 0, adr: null },
    ]);
  });

  it("passes on the database's refusal in its own words", async () => {
    await expect(
      loadBusinessNumbers(client({ data: null, error: { message: "Business numbers are shown for real properties only." } }), "h1", "2026-10-01", "2026-10-01"),
    ).rejects.toThrow("Business numbers are shown for real properties only.");
  });
});

describe("businessTotals", () => {
  it("adds nights up: sold over available, all revenue, ADR over rooms sold", () => {
    expect(
      businessTotals([
        { stayDate: "2026-10-01", roomsSold: 4, roomsAvailable: 10, occupancyPct: 40, roomRevenue: 660, adr: 152.5 },
        { stayDate: "2026-10-02", roomsSold: 2, roomsAvailable: 12, occupancyPct: 16.7, roomRevenue: 200, adr: 100 },
      ]),
    ).toEqual({ roomsSold: 6, roomsAvailable: 22, occupancyPct: 27.3, roomRevenue: 860, adr: 135 });
    expect(businessTotals([])).toEqual({ roomsSold: 0, roomsAvailable: 0, occupancyPct: null, roomRevenue: 0, adr: null });
  });
});

describe("businessByMonth", () => {
  it("adds the nights up month by month, oldest first", () => {
    const months = businessByMonth([
      { stayDate: "2026-11-01", roomsSold: 5, roomsAvailable: 10, occupancyPct: 50, roomRevenue: 500, adr: 100 },
      { stayDate: "2026-10-30", roomsSold: 4, roomsAvailable: 10, occupancyPct: 40, roomRevenue: 660, adr: 152.5 },
      { stayDate: "2026-10-31", roomsSold: 2, roomsAvailable: 12, occupancyPct: 16.7, roomRevenue: 200, adr: 100 },
    ]);
    expect(months).toEqual([
      { month: "2026-10", totals: { roomsSold: 6, roomsAvailable: 22, occupancyPct: 27.3, roomRevenue: 860, adr: 135 } },
      { month: "2026-11", totals: { roomsSold: 5, roomsAvailable: 10, occupancyPct: 50, roomRevenue: 500, adr: 100 } },
    ]);
    expect(businessByMonth([])).toEqual([]);
  });
});
