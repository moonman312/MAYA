/**
 * What each calendar day shows and how its colours read (Settings): every
 * number a property can pick, the dash where there is nothing to show, the
 * defaults (the calendar as it always was), the rules a save is held to, and
 * both colour modes with the key's words beside them.
 */
import { describe, expect, it } from "vitest";
import type { CalendarDay, CalendarRoomType } from "@/types/domain";
import {
  CALENDAR_METRICS,
  DEFAULT_CALENDAR_DISPLAY,
  NIGHT_COLOR_CLASS,
  colorKey,
  colorKeyHelp,
  compactMoney,
  dayAdr,
  daySellableRevpar,
  displayFromRow,
  displayToRow,
  metricLine,
  nightColor,
  parseDisplay,
  priceRoomTypeName,
  shortMoney,
  withSlot,
  type CalendarDisplay,
} from "./calendar-display";

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

/** The Harbour Inn on Friday 13 November: 12 of 20 booked, $2,180 on the books. */
function friday(over: Partial<CalendarDay> = {}): CalendarDay {
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
      rt({ id: SUITE, name: "Suite", booked: 1, revenue: 300, current_rate: null, current_price: null }),
    ],
    ...over,
  };
}

const opts = (priceRoomTypeId: string | null = STANDARD) => ({ symbol: "$", priceRoomTypeId, priceRoomTypeName: "Standard" });

describe("the numbers a day can show", () => {
  it("defaults to the calendar as it always was", () => {
    expect(DEFAULT_CALENDAR_DISPLAY).toEqual({
      big: "occupancy",
      small: ["rooms_booked", "room_revenue"],
      price_room_type_id: null,
      colors: "standard",
    });
    const day = friday();
    expect(metricLine("occupancy", day, opts()).value).toBe("60%");
    expect(metricLine("rooms_booked", day, opts()).value).toBe("12/20 rooms");
    expect(metricLine("room_revenue", day, opts())).toMatchObject({ value: "$2.2k", tag: null, title: "Room revenue (booked nights)" });
  });

  it("shows each metric the way the day cell prints it", () => {
    const day = friday();
    expect(metricLine("occupancy", day, opts())).toMatchObject({ value: "60%", short: "60%", tag: null });
    expect(metricLine("rooms_booked", day, opts())).toMatchObject({ value: "12/20 rooms", short: "12/20", tag: null });
    expect(metricLine("room_revenue", day, opts())).toMatchObject({ value: "$2.2k", short: "$2.2k" });
    expect(metricLine("adr", day, opts())).toMatchObject({ value: "$182", tag: "ADR" });
    expect(metricLine("revpar", day, opts())).toMatchObject({ value: "$109", tag: "RevPAR" });
    expect(metricLine("price", day, opts())).toMatchObject({ value: "$165", tag: "Price", title: "Price for Standard" });
  });

  it("puts the property's own currency sign on every amount", () => {
    const day = friday();
    const euro = { symbol: "€", priceRoomTypeId: STANDARD, priceRoomTypeName: "Standard" };
    expect(metricLine("room_revenue", day, euro).value).toBe("€2.2k");
    expect(metricLine("adr", day, euro).value).toBe("€182");
    expect(metricLine("revpar", day, euro).value).toBe("€109");
    expect(metricLine("price", day, euro).value).toBe("€165");
    const cad = { symbol: "CAD ", priceRoomTypeId: STANDARD, priceRoomTypeName: "Standard" };
    expect(metricLine("price", day, cad).value).toBe("CAD 165");
  });

  it("shows a dash for the price when MAYA has published none, when no room type is picked, and when the room type is gone", () => {
    const day = friday();
    expect(metricLine("price", day, opts(SUITE)).value).toBe("–");
    expect(metricLine("price", day, opts(SUITE)).short).toBe("–");
    expect(metricLine("price", day, opts(null)).value).toBe("–");
    expect(metricLine("price", day, opts("33333333-3333-4333-8333-333333333333")).value).toBe("–");
  });

  it("shows a dash for ADR with nothing booked and RevPAR with nothing to sell", () => {
    const empty = friday({ booked: 0, revenue: 0, adr: null, total: 0, sellable_revpar: null });
    expect(metricLine("adr", empty, opts()).value).toBe("–");
    expect(metricLine("revpar", empty, opts()).value).toBe("–");
  });

  it("works ADR and RevPAR out from the day's own figures for a calendar from before they were sent", () => {
    const old = friday({ adr: undefined, sellable_revpar: undefined });
    expect(dayAdr(old)).toBeCloseTo(2180 / 12);
    expect(daySellableRevpar(old)).toBe(109);
    expect(dayAdr(friday({ adr: undefined, sellable_revpar: undefined, booked: 0 }))).toBeNull();
  });

  it("shortens money the way the revenue figure always did, and further on a phone", () => {
    expect(compactMoney(850, "$")).toBe("$850");
    expect(compactMoney(999.6, "$")).toBe("$1000");
    expect(compactMoney(2180, "$")).toBe("$2.2k");
    expect(compactMoney(11_240, "$")).toBe("$11.2k");
    expect(shortMoney(11_240, "$")).toBe("$11k");
    expect(shortMoney(9_940, "$")).toBe("$9.9k");
    expect(shortMoney(850, "$")).toBe("$850");
  });

  it("names the price's room type from the month it is on", () => {
    expect(priceRoomTypeName({ "13": friday() }, SUITE)).toBe("Suite");
    expect(priceRoomTypeName({ "13": friday() }, null)).toBeNull();
    expect(priceRoomTypeName({ "13": friday() }, "33333333-3333-4333-8333-333333333333")).toBeNull();
  });
});

describe("choosing the numbers", () => {
  const d = DEFAULT_CALENDAR_DISPLAY;

  it("swaps a number already showing into the slot it came from, so a day never shows one twice", () => {
    expect(withSlot(d, "big", "rooms_booked")).toMatchObject({ big: "rooms_booked", small: ["occupancy", "room_revenue"] });
    expect(withSlot(d, 1, "rooms_booked")).toMatchObject({ big: "occupancy", small: ["room_revenue", "rooms_booked"] });
    expect(withSlot(d, 0, "adr")).toMatchObject({ big: "occupancy", small: ["adr", "room_revenue"] });
    expect(withSlot(d, "big", "price")).toMatchObject({ big: "price", small: ["rooms_booked", "room_revenue"] });
  });

  it("takes the second small line up when the first is cleared, and never clears the big number", () => {
    expect(withSlot(d, 0, null)).toMatchObject({ small: ["room_revenue"] });
    expect(withSlot(d, 1, null)).toMatchObject({ small: ["rooms_booked"] });
    expect(withSlot(withSlot(d, 1, null), 0, null)).toMatchObject({ small: [] });
    expect(withSlot(d, "big", null)).toBe(d);
    // A second line picked with no first becomes the first.
    expect(withSlot({ ...d, small: [] }, 1, "adr")).toMatchObject({ small: ["adr"] });
  });

  it("keeps the colours and the room type when a number changes", () => {
    const reversed: CalendarDisplay = { ...d, colors: "reversed", price_room_type_id: SUITE };
    expect(withSlot(reversed, "big", "adr")).toMatchObject({ colors: "reversed", price_room_type_id: SUITE });
  });

  it("accepts a save within the rules, and says what is wrong with one that is not", () => {
    expect(parseDisplay({ big: "adr", small: ["occupancy"], colors: "reversed", price_room_type_id: null })).toEqual({
      ok: true,
      display: { big: "adr", small: ["occupancy"], price_room_type_id: null, colors: "reversed" },
    });
    expect(parseDisplay({ big: "price", small: [], colors: "standard", price_room_type_id: SUITE.toUpperCase() })).toMatchObject({
      ok: true,
      display: { price_room_type_id: SUITE },
    });
    expect(parseDisplay({ big: "profit", small: [], colors: "standard" })).toEqual({ ok: false, error: "Pick a big number from the list." });
    expect(parseDisplay({ big: "adr", small: ["adr"], colors: "standard" })).toEqual({ ok: false, error: "Each number can show once on a day." });
    expect(parseDisplay({ big: "adr", small: ["revpar", "revpar"], colors: "standard" })).toMatchObject({ ok: false });
    expect(parseDisplay({ big: "adr", small: ["revpar", "occupancy", "rooms_booked"], colors: "standard" })).toEqual({
      ok: false,
      error: "Pick up to 2 small lines from the list.",
    });
    expect(parseDisplay({ big: "adr", small: [], colors: "inverted" })).toEqual({ ok: false, error: "Pick Standard or Reversed colours." });
    expect(parseDisplay({ big: "price", small: [], colors: "standard", price_room_type_id: null })).toEqual({
      ok: false,
      error: "Pick the room type whose price to show.",
    });
    expect(parseDisplay({ big: "adr", small: [], colors: "standard", price_room_type_id: "not-a-uuid" })).toMatchObject({ ok: false });
    expect(parseDisplay(null)).toMatchObject({ ok: false });
  });

  it("reads a stored row, and the default for anything a row does not hold", () => {
    expect(displayFromRow(null)).toEqual(DEFAULT_CALENDAR_DISPLAY);
    expect(displayFromRow({})).toEqual({ ...DEFAULT_CALENDAR_DISPLAY, small: [] });
    const row = displayToRow({ big: "price", small: ["occupancy"], price_room_type_id: SUITE, colors: "reversed" });
    expect(row).toEqual({
      calendar_big_metric: "price",
      calendar_small_metric_1: "occupancy",
      calendar_small_metric_2: null,
      calendar_price_room_type_id: SUITE,
      calendar_colors: "reversed",
    });
    expect(displayFromRow(row)).toEqual({ big: "price", small: ["occupancy"], price_room_type_id: SUITE, colors: "reversed" });
    // An unknown word from a newer database falls back one field at a time.
    expect(displayFromRow({ calendar_big_metric: "goppar", calendar_small_metric_1: "adr", calendar_colors: "sepia" })).toEqual({
      big: "occupancy",
      small: ["adr"],
      price_room_type_id: null,
      colors: "standard",
    });
  });

  it("lists every metric the database accepts", () => {
    expect([...CALENDAR_METRICS]).toEqual(["occupancy", "rooms_booked", "room_revenue", "adr", "revpar", "price"]);
  });
});

describe("the colours", () => {
  it("shows the calendar's own colours in Standard", () => {
    expect(nightColor("green", "standard")).toBe("green");
    expect(nightColor("orange", "standard")).toBe("orange");
    expect(nightColor("red", "standard")).toBe("red");
  });

  it("swaps green and red in Reversed and keeps amber typical", () => {
    expect(nightColor("green", "reversed")).toBe("red");
    expect(nightColor("red", "reversed")).toBe("green");
    expect(nightColor("orange", "reversed")).toBe("orange");
  });

  it("keys Standard as strong green, typical amber, weak red", () => {
    expect(colorKey("standard")).toEqual([
      { color: "green", words: "Strong night", short: "Strong", cue: null },
      { color: "orange", words: "Typical night", short: "Typical", cue: null },
      { color: "red", words: "Weak night", short: "Weak", cue: null },
    ]);
  });

  it("keys Reversed with the same words in the swapped colours, each with its cue", () => {
    expect(colorKey("reversed")).toEqual([
      { color: "green", words: "Weak night", short: "Weak", cue: "keep working on it" },
      { color: "orange", words: "Typical night", short: "Typical", cue: null },
      { color: "red", words: "Strong night", short: "Strong", cue: "leave it" },
    ]);
  });

  it("keys each colour to the nights that really show it", () => {
    // A strong night (the calendar's green) shows in the colour its key entry says "Strong night" for.
    for (const mode of ["standard", "reversed"] as const) {
      const shownFor = (strength: "green" | "orange" | "red") => nightColor(strength, mode);
      const key = Object.fromEntries(colorKey(mode).map((k) => [k.color, k.words]));
      expect(key[shownFor("green")]).toBe("Strong night");
      expect(key[shownFor("orange")]).toBe("Typical night");
      expect(key[shownFor("red")]).toBe("Weak night");
    }
  });

  it("uses the green, amber and red the calendar always used", () => {
    expect(NIGHT_COLOR_CLASS).toEqual({ green: "bg-emerald-600", orange: "bg-amber-500", red: "bg-rose-600" });
  });

  it("explains the colours as revenue per room against the property's own nights, never as occupancy", () => {
    for (const mode of ["standard", "reversed"] as const) {
      const text = colorKeyHelp(mode).join(" ");
      expect(text).toMatch(/revenue per room/);
      expect(text).toMatch(/Upcoming nights are compared with other upcoming nights/);
      expect(text).not.toMatch(/occupancy/i);
      expect(text).not.toContain("—");
    }
    expect(colorKeyHelp("reversed").join(" ")).toMatch(/green marks the weak nights worth working on, red the strong ones/);
  });
});
