// @vitest-environment jsdom
/**
 * The calendar as the property set it up in Settings: each number a day can
 * show (with its dash when there is nothing to show), both colour modes on
 * the day's bar, and the key on the left saying truly what each colour
 * means. The defaults draw the day exactly as it always was.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarDisplay } from "@/lib/calendar-display";
import { DEFAULT_CALENDAR_DISPLAY } from "@/lib/calendar-display";
import type { CalendarDay, CalendarResponse, CalendarRoomType } from "@/types/domain";
import { CalendarColorKey } from "./calendar-color-key";
import { CalendarDayCell } from "./calendar-day-cell";
import { Dashboard } from "./dashboard";

const STANDARD = "11111111-1111-4111-8111-111111111111";
const SUITE = "22222222-2222-4222-8222-222222222222";

function rt(over: Partial<CalendarRoomType>): CalendarRoomType {
  return {
    id: STANDARD,
    name: "Standard",
    total_rooms: 12,
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

function day(over: Partial<CalendarDay> = {}): CalendarDay {
  return {
    occupancy_pct: 60,
    booked: 12,
    total: 20,
    revenue: 2180,
    weekday: "Friday",
    revpar: 109,
    color: "green",
    adr: 181.67,
    sellable_revpar: 109,
    room_types: [
      rt({ id: STANDARD, name: "Standard", booked: 8, revenue: 1280, current_rate: 165, current_price: 165 }),
      rt({ id: SUITE, name: "Suite", booked: 1, revenue: 300 }),
    ],
    ...over,
  };
}

function cell(display: CalendarDisplay, data: CalendarDay = day()) {
  render(
    <div className="grid">
      <CalendarDayCell
        day={13}
        data={data}
        display={display}
        symbol="$"
        priceRoomTypeName={display.price_room_type_id === SUITE ? "Suite" : "Standard"}
        selected={false}
        onSelect={() => {}}
      />
    </div>,
  );
  const button = screen.getByRole("button");
  const line = (metric: string) => button.querySelector(`[data-metric="${metric}"]`);
  /** The big number as a wide screen shows it. */
  const big = () => button.querySelector("[data-metric] span:last-child")?.textContent;
  const bar = () => button.querySelector("[data-color]")!;
  return { button, line, big, bar };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("a day with the default settings", () => {
  it("is the day as it always was: occupancy, rooms booked, room revenue, a green bar for a strong night", () => {
    const { button, line, big, bar } = cell(DEFAULT_CALENDAR_DISPLAY);
    expect(big()).toBe("60%");
    expect(line("rooms_booked")?.textContent).toBe("12/20 rooms");
    expect(line("room_revenue")?.textContent).toBe("$2.2k");
    expect(line("room_revenue")?.getAttribute("title")).toBe("Room revenue (booked nights)");
    // Two small lines, in that order, after the big number.
    expect([...button.querySelectorAll("[data-metric]")].map((e) => e.getAttribute("data-metric"))).toEqual([
      "occupancy",
      "rooms_booked",
      "room_revenue",
    ]);
    expect(bar().getAttribute("data-color")).toBe("green");
    expect(bar().className).toContain("bg-emerald-600");
  });
});

describe("each number a day can show", () => {
  it("ADR as the big number, then RevPAR and the price for a room type", () => {
    const { big, line } = cell({ big: "adr", small: ["revpar", "price"], price_room_type_id: STANDARD, colors: "standard" });
    expect(big()).toBe("$182");
    expect(line("revpar")?.textContent).toBe("RevPAR $109");
    expect(line("price")?.textContent).toBe("Price $165");
    expect(line("price")?.getAttribute("title")).toBe("Price for Standard");
  });

  it("room revenue as the big number, then occupancy and rooms booked", () => {
    const { big, line } = cell({ big: "room_revenue", small: ["occupancy", "rooms_booked"], price_room_type_id: null, colors: "standard" });
    expect(big()).toBe("$2.2k");
    expect(line("occupancy")?.textContent).toBe("60%");
    expect(line("rooms_booked")?.textContent).toBe("12/20 rooms");
  });

  it("the price as the big number, with a dash when MAYA has no price for that room type", () => {
    const { big, line } = cell({ big: "price", small: ["adr"], price_room_type_id: SUITE, colors: "standard" });
    expect(big()).toBe("–");
    expect(line("adr")?.textContent).toBe("ADR $182");
  });

  it("a dash for ADR on a night with nothing booked", () => {
    const { line } = cell(
      { big: "occupancy", small: ["adr"], price_room_type_id: null, colors: "standard" },
      day({ booked: 0, revenue: 0, adr: null, occupancy_pct: 0 }),
    );
    expect(line("adr")?.textContent).toBe("ADR –");
  });

  it("no small lines at all when the property picked none", () => {
    const { button } = cell({ big: "occupancy", small: [], price_room_type_id: null, colors: "standard" });
    expect(button.querySelectorAll("[data-metric]")).toHaveLength(1);
  });

  it("a short form for a day too narrow for the full one, on a phone", () => {
    const { line } = cell({ big: "rooms_booked", small: [], price_room_type_id: null, colors: "standard" });
    const spans = [...line("rooms_booked")!.querySelectorAll("span")].map((s) => s.textContent);
    expect(spans).toEqual(["12/20", "12/20 rooms"]);
  });
});

describe("the colour modes on a day's bar", () => {
  const reversed: CalendarDisplay = { ...DEFAULT_CALENDAR_DISPLAY, colors: "reversed" };

  it("shows a strong night red and a weak night green when reversed", () => {
    expect(cell(reversed, day({ color: "green" })).bar().getAttribute("data-color")).toBe("red");
    cleanup();
    const weak = cell(reversed, day({ color: "red" })).bar();
    expect(weak.getAttribute("data-color")).toBe("green");
    expect(weak.className).toContain("bg-emerald-600");
  });

  it("keeps a typical night amber in both modes", () => {
    expect(cell(reversed, day({ color: "orange" })).bar().className).toContain("bg-amber-500");
    cleanup();
    expect(cell(DEFAULT_CALENDAR_DISPLAY, day({ color: "orange" })).bar().className).toContain("bg-amber-500");
  });
});

describe("the colour key", () => {
  /** Each entry: its colour, its swatch, what a wide screen shows, what a phone shows, what a screen reader hears. */
  const entries = () =>
    [...screen.getByTestId("calendar-color-key").querySelectorAll("[data-color]")].map((e) => [
      e.getAttribute("data-color"),
      e.querySelector("span[aria-hidden]")!.className.match(/bg-\w+-\d+/)![0],
      e.querySelector('[data-form="full"]')!.textContent,
      e.querySelector('[data-form="short"]')!.textContent,
      e.querySelector('[data-form="spoken"]')!.textContent,
    ]);

  it("reads strong green, typical amber, weak red in Standard", () => {
    render(<CalendarColorKey mode="standard" />);
    expect(entries()).toEqual([
      ["green", "bg-emerald-600", "Strong night", "Strong", "Green: Strong night"],
      ["orange", "bg-amber-500", "Typical night", "Typical", "Amber: Typical night"],
      ["red", "bg-rose-600", "Weak night", "Weak", "Red: Weak night"],
    ]);
  });

  it("reads the same three words in the swapped colours in Reversed, with a cue on each end", () => {
    render(<CalendarColorKey mode="reversed" />);
    expect(entries()).toEqual([
      ["green", "bg-emerald-600", "Weak night, keep working on it", "Weak", "Green: Weak night, keep working on it"],
      ["orange", "bg-amber-500", "Typical night", "Typical", "Amber: Typical night"],
      ["red", "bg-rose-600", "Strong night, leave it", "Strong", "Red: Strong night, leave it"],
    ]);
  });

  it("shows only the short words on a phone, so its line fits at every text size, and the full words from 1024px", () => {
    for (const mode of ["standard", "reversed"] as const) {
      render(<CalendarColorKey mode={mode} />);
      const key = screen.getByTestId("calendar-color-key");
      for (const short of key.querySelectorAll('[data-form="short"]')) {
        expect(short.className.split(" ")).toContain("lg:hidden");
        expect(short.getAttribute("aria-hidden")).toBe("true");
      }
      for (const full of key.querySelectorAll('[data-form="full"]')) {
        expect(full.className.split(" ")).toEqual(expect.arrayContaining(["hidden", "lg:inline"]));
      }
      // The phone's line, all three entries: short enough for one line at
      // Larger on a 375px phone (checked in a browser, with the "?").
      const phone = [...key.querySelectorAll('[data-form="short"]')].map((e) => e.textContent).join(" ");
      expect(phone.length).toBeLessThanOrEqual("Strong Typical Weak".length);
      cleanup();
    }
  });

  it("keeps how a colour is worked out behind the question mark, and never calls it occupancy", () => {
    render(<CalendarColorKey mode="reversed" />);
    const key = screen.getByTestId("calendar-color-key");
    expect(key.textContent).not.toMatch(/revenue per room/);
    fireEvent.click(within(key).getByRole("button", { name: "What the colours mean" }));
    const text = key.textContent ?? "";
    expect(text).toMatch(/revenue per room with this property's own nights/);
    expect(text).toMatch(/Upcoming nights are compared with other upcoming nights/);
    expect(text).toMatch(/green marks the weak nights worth working on/);
    expect(text).not.toMatch(/occupancy/i);
  });

  it("says nothing until it knows the property's colours", () => {
    render(<CalendarColorKey mode={null} />);
    expect(screen.getByTestId("calendar-color-key").textContent).toBe("");
  });
});

describe("the calendar tab", () => {
  function month(display: CalendarDisplay | undefined): CalendarResponse {
    const days: CalendarResponse["days"] = {};
    for (let d = 1; d <= 31; d++) days[String(d)] = day({ color: d === 10 ? "red" : "green" });
    return {
      year: 2026,
      month: 10,
      month_name: "October 2026",
      days_in_month: 31,
      first_weekday: 4,
      thresholds: { low: 60, high: 80, basis: "revpar", past: { p33: 1, p67: 2 }, future: { p33: 1, p67: 2 } },
      range: { min: "2026-01", max: "2026-12" },
      currency: "USD",
      ...(display ? { display } : {}),
      days,
    };
  }

  function stub(display: CalendarDisplay | undefined) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
        if (/^\/api\/calendar\/\d+\/\d+$/.test(url)) return json(month(display));
        if (url === "/api/rules" || url === "/api/rules/stops" || url === "/api/room-types") return json([]);
        if (url === "/api/rules/fire-counts") return json({});
        if (url === "/api/hotels") return json({ hotels: [], activeHotelId: null });
        return new Response(null, { status: 204 });
      }),
    );
  }

  beforeEach(() => {
    window.history.replaceState(null, "", "/?month=2026-10");
  });

  it("draws every day with the property's numbers and colours, and the key to the left of the grid, with no legend under it", async () => {
    stub({ big: "adr", small: ["price"], price_room_type_id: STANDARD, colors: "reversed" });
    render(<Dashboard initialSearch={window.location.search} />);
    const tenth = await screen.findByRole("button", { name: /^10\b/ });
    expect(tenth.querySelector('[data-metric="adr"] span:last-child')?.textContent).toBe("$182");
    expect(tenth.querySelector('[data-metric="price"]')?.textContent).toBe("Price $165");
    // A weak night, reversed: green.
    expect(tenth.querySelector("[data-color]")?.getAttribute("data-color")).toBe("green");
    const key = screen.getByTestId("calendar-color-key");
    expect(key.getAttribute("data-mode")).toBe("reversed");
    // The key sits before the grid, in the same row on a wide screen.
    const grid = tenth.parentElement!;
    expect(key.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(key.parentElement!.className).toContain("lg:flex-row");
    expect(document.body.textContent).not.toMatch(/Measured by revenue per room/);
  });

  it("keeps the room beside the days on a phone in px, so a larger text size never makes the days' numbers smaller", async () => {
    stub(undefined);
    render(<Dashboard initialSearch={window.location.search} />);
    const tenth = await screen.findByRole("button", { name: /^10\b/ });
    // Every side padding and gap that applies below 640px (no breakpoint
    // prefix), from the day out to the page: in rem these grow with the text
    // size and take width from the seven days sharing the phone's screen.
    const found: string[] = [];
    for (let el: HTMLElement | null = tenth; el && el !== document.body; el = el.parentElement) {
      const classes = el.className.split(/\s+/);
      const column = classes.includes("flex-col");
      for (const c of classes) {
        if (/^(p|px|pl|pr)-/.test(c) || (/^gap(-x)?-/.test(c) && !column)) found.push(c);
      }
      if (classes.includes("max-w-6xl")) break;
    }
    expect(found.length).toBeGreaterThanOrEqual(4);
    expect(found.filter((c) => !/-\[\d+px\]$|-0$/.test(c))).toEqual([]);
  });

  it("reads a calendar with no settings on it as the calendar always was", async () => {
    stub(undefined);
    render(<Dashboard initialSearch={window.location.search} />);
    const tenth = await screen.findByRole("button", { name: /^10\b/ });
    expect(tenth.querySelector('[data-metric="occupancy"] span:last-child')?.textContent).toBe("60%");
    expect(tenth.querySelector('[data-metric="rooms_booked"]')?.textContent).toBe("12/20 rooms");
    expect(tenth.querySelector('[data-metric="room_revenue"]')?.textContent).toBe("$2.2k");
    expect(tenth.querySelector("[data-color]")?.getAttribute("data-color")).toBe("red");
    expect(screen.getByTestId("calendar-color-key").getAttribute("data-mode")).toBe("standard");
  });
});
