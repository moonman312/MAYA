/**
 * What each calendar day shows, and how its colour reads: the property's own
 * choice in Settings (hotel_settings.calendar_*), the same for everyone on it.
 *
 * The defaults are the calendar as it always was: sellable occupancy as the
 * big number, then rooms booked and room revenue, in the standard colours.
 * Everything here is pure, so the day cell, the colour key, the Settings
 * section and the save route all read one set of rules.
 */

import type { DayColor } from "@/lib/calendar-color";
import type { CalendarDay } from "@/types/domain";

export const CALENDAR_METRICS = ["occupancy", "rooms_booked", "room_revenue", "adr", "revpar", "price"] as const;
export type CalendarMetric = (typeof CALENDAR_METRICS)[number];

export const CALENDAR_COLOR_MODES = ["standard", "reversed"] as const;
export type CalendarColors = (typeof CALENDAR_COLOR_MODES)[number];

/** How many small lines a day can show under its big number. */
export const MAX_SMALL_LINES = 2;

export type CalendarDisplay = {
  /** The big number on each day. */
  big: CalendarMetric;
  /** The small lines under it, top first: none, one or two, never repeating the big number or each other. */
  small: CalendarMetric[];
  /** The room type "Price for" shows; null when none is picked. */
  price_room_type_id: string | null;
  /** standard: green strong, red weak. reversed: green weak, red strong. */
  colors: CalendarColors;
};

export const DEFAULT_CALENDAR_DISPLAY: CalendarDisplay = {
  big: "occupancy",
  small: ["rooms_booked", "room_revenue"],
  price_room_type_id: null,
  colors: "standard",
};

/** Names in the Settings lists. "price" is followed by the room type picker. */
export const METRIC_LABELS: Record<CalendarMetric, string> = {
  occupancy: "Occupancy",
  rooms_booked: "Rooms booked",
  room_revenue: "Room revenue",
  adr: "ADR",
  revpar: "RevPAR",
  price: "Price for a room type",
};

export function isCalendarMetric(v: unknown): v is CalendarMetric {
  return typeof v === "string" && (CALENDAR_METRICS as readonly string[]).includes(v);
}

export function isCalendarColors(v: unknown): v is CalendarColors {
  return typeof v === "string" && (CALENDAR_COLOR_MODES as readonly string[]).includes(v);
}

/** True when the price line shows anywhere on the day. */
export function usesPrice(d: Pick<CalendarDisplay, "big" | "small">): boolean {
  return d.big === "price" || d.small.includes("price");
}

/* ── Stored row <-> display ──────────────────────────────────────────── */

export type CalendarDisplayRow = {
  calendar_big_metric?: unknown;
  calendar_small_metric_1?: unknown;
  calendar_small_metric_2?: unknown;
  calendar_price_room_type_id?: unknown;
  calendar_colors?: unknown;
};

/**
 * The display a hotel_settings row holds. Anything unreadable (a missing
 * row, a database before the migration) is the default, one field at a time.
 */
export function displayFromRow(row: CalendarDisplayRow | null | undefined): CalendarDisplay {
  if (!row) return { ...DEFAULT_CALENDAR_DISPLAY, small: [...DEFAULT_CALENDAR_DISPLAY.small] };
  const big = isCalendarMetric(row.calendar_big_metric) ? row.calendar_big_metric : DEFAULT_CALENDAR_DISPLAY.big;
  const small: CalendarMetric[] = [];
  for (const m of [row.calendar_small_metric_1, row.calendar_small_metric_2]) {
    if (isCalendarMetric(m) && m !== big && !small.includes(m)) small.push(m);
  }
  const rt = row.calendar_price_room_type_id;
  return {
    big,
    small,
    price_room_type_id: typeof rt === "string" && rt.length > 0 ? rt : null,
    colors: isCalendarColors(row.calendar_colors) ? row.calendar_colors : DEFAULT_CALENDAR_DISPLAY.colors,
  };
}

/** The hotel_settings columns for a display. */
export function displayToRow(d: CalendarDisplay): Required<CalendarDisplayRow> {
  return {
    calendar_big_metric: d.big,
    calendar_small_metric_1: d.small[0] ?? null,
    calendar_small_metric_2: d.small[1] ?? null,
    calendar_price_room_type_id: d.price_room_type_id,
    calendar_colors: d.colors,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One save from Settings: only what the owner just changed, so two people
 * saving different choices at once never undo each other. The day's numbers
 * (big and small) travel together, since picking one can swap two; the
 * room type the price comes from and the colours each travel alone. The
 * server lays it over what is saved (applyDisplayPatch).
 */
export type CalendarDisplayPatch = {
  big?: CalendarMetric;
  small?: CalendarMetric[];
  price_room_type_id?: string | null;
  colors?: CalendarColors;
};

/** A save request, checked; the error is a sentence for the owner. */
export function parseDisplayPatch(body: unknown): { ok: true; patch: CalendarDisplayPatch } | { ok: false; error: string } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Pick a choice from the list." };
  const b = body as Record<string, unknown>;
  const patch: CalendarDisplayPatch = {};
  if ("big" in b || "small" in b) {
    if (!isCalendarMetric(b.big)) return { ok: false, error: "Pick a big number from the list." };
    const rawSmall = b.small ?? [];
    if (!Array.isArray(rawSmall) || rawSmall.length > MAX_SMALL_LINES || !rawSmall.every(isCalendarMetric)) {
      return { ok: false, error: `Pick up to ${MAX_SMALL_LINES} small lines from the list.` };
    }
    const small = rawSmall as CalendarMetric[];
    if (small.includes(b.big) || new Set(small).size !== small.length) {
      return { ok: false, error: "Each number can show once on a day." };
    }
    patch.big = b.big;
    patch.small = [...small];
  }
  if ("colors" in b) {
    if (!isCalendarColors(b.colors)) return { ok: false, error: "Pick Standard or Reversed colours." };
    patch.colors = b.colors;
  }
  if ("price_room_type_id" in b) {
    const rt = b.price_room_type_id ?? null;
    if (rt !== null && (typeof rt !== "string" || !UUID.test(rt))) return { ok: false, error: "Pick a room type from the list." };
    patch.price_room_type_id = rt === null ? null : rt.toLowerCase();
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: "Pick a choice from the list." };
  return { ok: true, patch };
}

/** The display once a save's changes are laid over it. */
export function applyDisplayPatch(d: CalendarDisplay, patch: CalendarDisplayPatch): CalendarDisplay {
  return {
    big: patch.big ?? d.big,
    small: patch.big !== undefined ? [...(patch.small ?? [])] : [...d.small],
    price_room_type_id: patch.price_room_type_id !== undefined ? patch.price_room_type_id : d.price_room_type_id,
    colors: patch.colors ?? d.colors,
  };
}

/**
 * The display after the owner picks `metric` for one slot ("big", or small
 * line 0 or 1; null clears a small line). A number already showing elsewhere
 * swaps places with what the slot held, so a day never shows one number
 * twice, and a cleared first line takes the second one up.
 */
export function withSlot(d: CalendarDisplay, slot: "big" | 0 | 1, metric: CalendarMetric | null): CalendarDisplay {
  const lines: (CalendarMetric | null)[] = [d.big, d.small[0] ?? null, d.small[1] ?? null];
  const at = slot === "big" ? 0 : slot + 1;
  if (at === 0 && metric === null) return d;
  const previous = lines[at];
  const elsewhere = metric === null ? -1 : lines.findIndex((m, i) => i !== at && m === metric);
  lines[at] = metric;
  if (elsewhere >= 0) lines[elsewhere] = elsewhere === 0 ? (previous ?? d.big) : previous;
  const big = lines[0] as CalendarMetric;
  const small = lines.slice(1).filter((m): m is CalendarMetric => m !== null && m !== big);
  return { ...d, big, small: [...new Set(small)] };
}

/* ── One day's numbers ──────────────────────────────────────────────── */

/**
 * Money on a day cell: whole units under 1,000, then thousands with one
 * decimal ("$2.2k"), as the revenue figure always read.
 */
export function compactMoney(amount: number, symbol: string): string {
  return `${symbol}${amount >= 1000 ? `${(amount / 1000).toFixed(1)}k` : amount.toFixed(0)}`;
}

/** Money on a day too narrow for compactMoney (a phone): whole thousands from 10,000 ("$11k"). */
export function shortMoney(amount: number, symbol: string): string {
  return amount >= 10_000 ? `${symbol}${Math.round(amount / 1000)}k` : compactMoney(amount, symbol);
}

/**
 * ADR for the day: room revenue from the types that count as rooms, divided
 * by the rooms booked in them. Null when nothing is booked. A payload from
 * before the field existed works it out from the day's own figures.
 */
export function dayAdr(day: CalendarDay): number | null {
  if (day.adr !== undefined) return day.adr;
  return day.booked > 0 ? day.revenue / day.booked : null;
}

/** RevPAR for the day: that room revenue over the rooms you can sell. Null with none to sell. */
export function daySellableRevpar(day: CalendarDay): number | null {
  if (day.sellable_revpar !== undefined) return day.sellable_revpar;
  return day.total > 0 ? day.revenue / day.total : null;
}

/** MAYA's published price for the chosen room type that night, or null (a dash). */
export function dayPrice(day: CalendarDay, roomTypeId: string | null): number | null {
  if (!roomTypeId) return null;
  const rt = day.room_types.find((r) => r.id === roomTypeId);
  if (!rt) return null;
  return rt.current_rate ?? rt.current_price ?? null;
}

export type MetricLine = {
  /** The number as the cell prints it; "–" when there is nothing to show. */
  value: string;
  /** The same number for a day too narrow to hold `value` (a phone): "44/85", "$11k". */
  short: string;
  /** A short word in front of it on a small line, where the number alone would be ambiguous. */
  tag: string | null;
  /** What the number is, for the hover title. */
  title: string;
};

export const NO_VALUE = "–";

export function metricLine(
  metric: CalendarMetric,
  day: CalendarDay,
  opts: { symbol: string; priceRoomTypeId: string | null; priceRoomTypeName: string | null },
): MetricLine {
  const money = (n: number | null) =>
    n == null || !Number.isFinite(n)
      ? { value: NO_VALUE, short: NO_VALUE }
      : { value: compactMoney(n, opts.symbol), short: shortMoney(n, opts.symbol) };
  switch (metric) {
    case "occupancy": {
      const v = `${day.occupancy_pct}%`;
      return { value: v, short: v, tag: null, title: "Sellable occupancy" };
    }
    case "rooms_booked":
      return {
        value: `${day.booked}/${day.total} rooms`,
        short: `${day.booked}/${day.total}`,
        tag: null,
        title: "Rooms booked / rooms you can sell",
      };
    case "room_revenue":
      return { ...money(day.revenue), tag: null, title: "Room revenue (booked nights)" };
    case "adr":
      return { ...money(dayAdr(day)), tag: "ADR", title: "ADR: room revenue per room booked" };
    case "revpar":
      return { ...money(daySellableRevpar(day)), tag: "RevPAR", title: "RevPAR: room revenue per room you can sell" };
    case "price":
      return {
        ...money(dayPrice(day, opts.priceRoomTypeId)),
        tag: "Price",
        title: opts.priceRoomTypeName ? `Price for ${opts.priceRoomTypeName}` : "Price",
      };
  }
}

/** The room type name "Price for" names, read off the month's own room types. */
export function priceRoomTypeName(days: Record<string, CalendarDay>, roomTypeId: string | null): string | null {
  if (!roomTypeId) return null;
  for (const day of Object.values(days)) {
    const rt = day.room_types.find((r) => r.id === roomTypeId);
    if (rt) return rt.name;
  }
  return null;
}

/* ── Colours ────────────────────────────────────────────────────────── */

/** The bar's class for each colour the day shows. */
export const NIGHT_COLOR_CLASS: Record<DayColor, string> = {
  green: "bg-emerald-600",
  orange: "bg-amber-500",
  red: "bg-rose-600",
};

/**
 * The colour a night shows. The calendar's own colour is the standard one
 * (green strong, amber typical, red weak); reversed swaps green and red, and
 * amber stays typical.
 */
export function nightColor(color: DayColor, mode: CalendarColors): DayColor {
  if (mode !== "reversed" || color === "orange") return color;
  return color === "green" ? "red" : "green";
}

export type ColorKeyEntry = {
  color: DayColor;
  /** "Strong night", "Typical night" or "Weak night". */
  words: string;
  /** "Strong", "Typical" or "Weak": the key's one line on a phone, where the full words don't fit at a larger text size. */
  short: string;
  /** A short cue after the words where the colours are reversed. */
  cue: string | null;
};

/** The key beside the calendar, green first, in the property's colours. */
export function colorKey(mode: CalendarColors): ColorKeyEntry[] {
  if (mode === "reversed") {
    return [
      { color: "green", words: "Weak night", short: "Weak", cue: "keep working on it" },
      { color: "orange", words: "Typical night", short: "Typical", cue: null },
      { color: "red", words: "Strong night", short: "Strong", cue: "leave it" },
    ];
  }
  return [
    { color: "green", words: "Strong night", short: "Strong", cue: null },
    { color: "orange", words: "Typical night", short: "Typical", cue: null },
    { color: "red", words: "Weak night", short: "Weak", cue: null },
  ];
}

/** Behind the key's "?": how a night gets its colour. */
export function colorKeyHelp(mode: CalendarColors): string[] {
  const lines = [
    "Each night's colour compares its revenue per room with this property's own nights.",
    "Upcoming nights are compared with other upcoming nights, and past nights with past nights.",
    "A full night can still be a weak one if its rooms sold for less than usual.",
  ];
  if (mode === "reversed") {
    lines.push("Your property has reversed colours in Settings: green marks the weak nights worth working on, red the strong ones.");
  }
  return lines;
}
