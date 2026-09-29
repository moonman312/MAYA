// @vitest-environment jsdom
/**
 * The calendar's day card. A room type with nothing booked has no average
 * rate, so its ADR line shows a dash rather than a number nobody earned.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarResponse, CalendarRoomType } from "@/types/domain";
import { Dashboard } from "./dashboard";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function cell(over: Partial<CalendarRoomType>): CalendarRoomType {
  return {
    id: "rt1",
    name: "Standard",
    total_rooms: 10,
    occupancy_pct: 0,
    booked: 0,
    rate: null,
    revenue: 0,
    current_price: null,
    current_rate: null,
    base_price: null,
    manual_price: null,
    ...over,
  };
}

function month(y: number, m: number): CalendarResponse {
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const days: CalendarResponse["days"] = {};
  for (let d = 1; d <= daysInMonth; d++) {
    days[String(d)] = {
      occupancy_pct: 10,
      booked: 1,
      total: 20,
      revenue: 120,
      weekday: "Saturday",
      revpar: 6,
      color: "red",
      room_types: [
        cell({ id: "rt1", name: "Standard", booked: 1, occupancy_pct: 10, rate: 120, revenue: 120 }),
        cell({ id: "rt2", name: "Suite" }),
      ],
    };
  }
  return {
    year: y,
    month: m,
    month_name: `${y}-${m}`,
    days_in_month: daysInMonth,
    first_weekday: new Date(Date.UTC(y, m - 1, 1)).getUTCDay(),
    thresholds: { low: 60, high: 80, basis: "revpar", past: { p33: 1, p67: 2 }, future: { p33: 1, p67: 2 } },
    range: { min: `${y}-01`, max: `${y}-12` },
    days,
  };
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const cal = /^\/api\/calendar\/(\d+)\/(\d+)$/.exec(url);
      if (cal) return json(month(Number(cal[1]), Number(cal[2])));
      if (url === "/api/rules") return json([]);
      if (url === "/api/rules/fire-counts") return json({});
      if (url === "/api/rules/stops") return json([]);
      if (url === "/api/room-types") return json([]);
      if (url === "/api/hotels") return json({ hotels: [], activeHotelId: null });
      if (url === "/api/events") return new Response(null, { status: 204 });
      return json({}, 404);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("the day card's ADR", () => {
  it("shows the average for a booked room type and a dash for one with nothing booked", async () => {
    window.history.replaceState(null, "", "/?tab=calendar");
    render(<Dashboard initialSearch={window.location.search} />);

    const tenth = await screen.findByRole("button", { name: /^10\b/ });
    fireEvent.click(tenth);

    expect(await screen.findByText("ADR $120.00")).toBeTruthy();
    expect(screen.getByText("ADR –")).toBeTruthy();
  });
});
