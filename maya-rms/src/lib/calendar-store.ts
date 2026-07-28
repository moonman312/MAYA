/**
 * Calendar data provider.
 *
 * When a Supabase client is supplied the function queries the reservations +
 * room_types tables.  Otherwise it generates deterministic demo data that
 * matches the Python legacy dashboard.
 */

import {
  buildRevparScale,
  colorForRevpar,
  computeRevpar,
  isDateInPeriods,
  scaleToThresholds,
  splitRevparSeries,
  type RevparDatum,
} from "@/lib/calendar-color";
import { formatUtcMonthYear } from "@/lib/calendar-month-label";
import { ROOM_TYPES } from "@/lib/demo-data";
import { evalIsoToHotelDateString } from "@/lib/engine/timezone";
import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import type { CalendarDay, CalendarResponse, CalendarRoomType } from "@/types/domain";
import type { SupabaseClient } from "@supabase/supabase-js";

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Legacy occupancy-percent cutoffs, kept for older consumers of `thresholds`. */
const THRESHOLDS = { low: 60, high: 80 };

const DAY_MS = 86_400_000;

/** Months either side of today covered by the demo dataset. */
const DEMO_RANGE_MONTHS = 12;

/* ── Public entry point ───────────────────────────────────────── */

export async function getCalendar(
  year: number,
  month: number,
  supabase?: SupabaseClient,
): Promise<CalendarResponse> {
  if (supabase) {
    return getCalendarFromDb(year, month, supabase);
  }
  return getCalendarDemo(year, month);
}

/* ── Shared helpers ───────────────────────────────────────────── */

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function monthKey(year: number, month: number): string {
  return `${year}-${pad2(month)}`;
}

/**
 * Fetch ALL rows for a query, paging past Supabase's "Max rows" API cap
 * (default 1000). `makeQuery` must return a fresh query builder with a STABLE
 * `.order(...)` applied (so page ranges don't overlap or skip rows); this
 * helper only appends `.range()`. Without it, bulk reads silently truncate
 * at 1000 rows.
 */
async function fetchAllRows<T>(
  makeQuery: () => {
    range: (
      from: number,
      to: number,
    ) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
  },
  pageSize = 1000,
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  let guard = 0;
  for (;;) {
    if (++guard > 1000) break; // safety backstop (~1M rows)
    const { data, error } = await makeQuery().range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    all.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

/* ── Demo / fallback calendar ─────────────────────────────────── */

/** Deterministic pseudo-random demo numbers for one stay date. */
function demoDayNumbers(
  year: number,
  month: number,
  d: number,
): { roomTypes: CalendarRoomType[]; totalRooms: number; totalBooked: number; totalRevenue: number } {
  // Deterministic pseudo-random occupancy seeded by date
  const seed = year * 10000 + month * 100 + d;

  const roomTypes: CalendarRoomType[] = ROOM_TYPES.map((rt) => {
    const hash = ((seed * 31 + rt.name.charCodeAt(0)) % 100);
    const occPct = Math.min(100, Math.max(15, hash + 10));
    const booked = Math.round((occPct / 100) * rt.total_rooms);
    const rate = rt.base_rate * (1 + (occPct > 80 ? 0.1 : occPct < 40 ? -0.05 : 0));
    const revenue = Math.round(booked * rate * 100) / 100;

    return {
      id: rt.name,
      name: rt.name,
      total_rooms: rt.total_rooms,
      occupancy_pct: occPct,
      booked,
      rate: Math.round(rate * 100) / 100,
      revenue,
      current_price: null, // demo mode has no pricing engine output
      current_rate: Math.round(rate * 100) / 100, // demo stand-in for a published price
    };
  });

  return {
    roomTypes,
    totalRooms: roomTypes.reduce((s, rt) => s + rt.total_rooms, 0),
    totalBooked: roomTypes.reduce((s, rt) => s + rt.booked, 0),
    totalRevenue: roomTypes.reduce((s, rt) => s + rt.revenue, 0),
  };
}

function getCalendarDemo(year: number, month: number): CalendarResponse {
  const firstDay = new Date(Date.UTC(year, month - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const firstWeekday = firstDay.getUTCDay(); // 0 = Sunday
  const monthName = formatUtcMonthYear(year, month);

  // The demo dataset spans a fixed window around today; RevPAR terciles and
  // the navigable range both derive from it.
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const windowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - DEMO_RANGE_MONTHS, 1));
  const windowEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + DEMO_RANGE_MONTHS + 1, 0));

  const series: RevparDatum[] = [];
  for (let t = windowStart.getTime(); t <= windowEnd.getTime(); t += DAY_MS) {
    const dt = new Date(t);
    const { totalRooms, totalRevenue } = demoDayNumbers(
      dt.getUTCFullYear(),
      dt.getUTCMonth() + 1,
      dt.getUTCDate(),
    );
    series.push({
      date: dt.toISOString().slice(0, 10),
      revpar: computeRevpar(totalRevenue, totalRooms),
    });
  }
  const split = splitRevparSeries(series, todayStr);
  const scale = buildRevparScale(split.past, split.future);

  const days: Record<string, CalendarDay> = {};

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${pad2(month)}-${pad2(d)}`;
    const dayDate = new Date(Date.UTC(year, month - 1, d));
    const weekday = WEEKDAY_NAMES[dayDate.getUTCDay()];

    const { roomTypes, totalRooms, totalBooked, totalRevenue } = demoDayNumbers(year, month, d);
    const occPct = totalRooms > 0 ? Math.round((totalBooked / totalRooms) * 100) : 0;
    const revpar = computeRevpar(totalRevenue, totalRooms);

    days[String(d)] = {
      occupancy_pct: occPct,
      booked: totalBooked,
      total: totalRooms,
      revenue: Math.round(totalRevenue * 100) / 100,
      weekday,
      room_types: roomTypes,
      revpar,
      color: colorForRevpar(revpar, dateStr < todayStr ? scale.past : scale.future),
    };
  }

  return {
    year,
    month,
    month_name: monthName,
    days_in_month: daysInMonth,
    first_weekday: firstWeekday,
    thresholds: { ...THRESHOLDS, ...scaleToThresholds(scale) },
    range: {
      min: monthKey(windowStart.getUTCFullYear(), windowStart.getUTCMonth() + 1),
      max: monthKey(windowEnd.getUTCFullYear(), windowEnd.getUTCMonth() + 1),
    },
    days,
  };
}

/* ── Supabase-backed calendar ─────────────────────────────────── */

async function getCalendarFromDb(
  year: number,
  month: number,
  supabase: SupabaseClient,
): Promise<CalendarResponse> {
  const hotelId = await resolveAccessibleHotelId(supabase);
  if (!hotelId) {
    return getCalendarDemo(year, month);
  }

  const { data: hotelRow } = await supabase
    .from("hotels")
    .select("total_rooms_per_type, timezone")
    .eq("id", hotelId)
    .maybeSingle();

  const hotelFallbackRooms = hotelRow?.total_rooms_per_type ?? 100;
  const defaultBaseRate = 150;
  const todayStr = evalIsoToHotelDateString(new Date().toISOString(), hotelRow?.timezone ?? "UTC");

  const startDate = `${year}-${pad2(month)}-01`;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const endDate = `${year}-${pad2(month)}-${pad2(daysInMonth)}`;

  const { data: roomTypeRows } = await supabase
    .from("room_types")
    .select("id, name, total_rooms")
    .eq("hotel_id", hotelId)
    .eq("is_active", true)
    .order("name");

  const rtList =
    roomTypeRows && roomTypeRows.length > 0
      ? roomTypeRows.map((rt) => ({
          id: String(rt.id),
          name: rt.name,
          total_rooms: typeof rt.total_rooms === "number" && rt.total_rooms > 0 ? rt.total_rooms : hotelFallbackRooms,
          base_rate: defaultBaseRate,
        }))
      : ROOM_TYPES.map((rt) => ({
          id: rt.name,
          name: rt.name,
          total_rooms: rt.total_rooms,
          base_rate: rt.base_rate,
        }));

  const { data: reservations } = await supabase
    .from("reservations")
    .select("stay_date, room_type_id, base_rate, current_rate")
    .eq("hotel_id", hotelId)
    .gte("stay_date", startDate)
    .lte("stay_date", endDate);

  // Engine-published prices (the current asking price after rules + clamps).
  // Written by /api/evaluate into published_price; absent until the first
  // evaluation run, so the UI treats null as "not priced yet".
  const { data: publishedPrices } = await supabase
    .from("published_price")
    .select("stay_date, room_type_id, price")
    .eq("hotel_id", hotelId)
    .gte("stay_date", startDate)
    .lte("stay_date", endDate);

  const publishedByKey = new Map<string, number>();
  for (const p of publishedPrices ?? []) {
    const price = p.price != null ? Number(p.price) : NaN;
    if (Number.isFinite(price)) {
      publishedByKey.set(`${p.stay_date}|${String(p.room_type_id)}`, price);
    }
  }

  // Full-history nightly revenue (sum of current_rate per stay date) — the
  // hotel-wide RevPAR series that the day colors are judged against.
  const seriesRows = await fetchAllRows<{ stay_date: string; current_rate: number | string | null }>(() =>
    supabase
      .from("reservations")
      .select("stay_date, current_rate")
      .eq("hotel_id", hotelId)
      .order("id", { ascending: true }),
  );

  const revenueByDate = new Map<string, number>();
  let minStayDate: string | null = null;
  let maxStayDate: string | null = null;
  for (const row of seriesRows) {
    const stayDate = String(row.stay_date);
    const amount = Number(row.current_rate ?? 0);
    revenueByDate.set(
      stayDate,
      (revenueByDate.get(stayDate) ?? 0) + (Number.isFinite(amount) ? amount : 0),
    );
    if (minStayDate === null || stayDate < minStayDate) minStayDate = stayDate;
    if (maxStayDate === null || stayDate > maxStayDate) maxStayDate = stayDate;
  }

  // Confirmed closures are excluded from threshold computation (a closed day
  // says nothing about how a normal day performs) but still get colored.
  const { data: closedRows } = await supabase
    .from("hotel_closed_periods")
    .select("start_date, end_date")
    .eq("hotel_id", hotelId);
  const closedPeriods = (closedRows ?? []).map((p) => ({
    start_date: String(p.start_date),
    end_date: String(p.end_date),
  }));

  const totalRoomsProperty = rtList.reduce((s, rt) => s + rt.total_rooms, 0);

  const series: RevparDatum[] = [];
  for (const [date, revenue] of revenueByDate) {
    series.push({
      date,
      revpar: computeRevpar(revenue, totalRoomsProperty),
      closed: isDateInPeriods(date, closedPeriods),
    });
  }
  const split = splitRevparSeries(series, todayStr);
  const scale = buildRevparScale(split.past, split.future);

  // Navigable range: first/last month with any reservation or published price.
  const { data: ppMinRow } = await supabase
    .from("published_price")
    .select("stay_date")
    .eq("hotel_id", hotelId)
    .order("stay_date", { ascending: true })
    .limit(1)
    .maybeSingle();
  const { data: ppMaxRow } = await supabase
    .from("published_price")
    .select("stay_date")
    .eq("hotel_id", hotelId)
    .order("stay_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  const dateCandidates = [
    minStayDate,
    maxStayDate,
    ppMinRow?.stay_date != null ? String(ppMinRow.stay_date) : null,
    ppMaxRow?.stay_date != null ? String(ppMaxRow.stay_date) : null,
  ].filter((v): v is string => typeof v === "string" && v.length >= 7);

  const requestedMonth = monthKey(year, month);
  const range =
    dateCandidates.length > 0
      ? {
          min: dateCandidates.reduce((a, b) => (a < b ? a : b)).slice(0, 7),
          max: dateCandidates.reduce((a, b) => (a > b ? a : b)).slice(0, 7),
        }
      : { min: requestedMonth, max: requestedMonth };

  // Build a lookup: room_type_id -> room type info
  const rtById: Record<string, { name: string; total_rooms: number; base_rate: number }> = {};
  for (const rt of rtList) {
    rtById[String(rt.id)] = { name: rt.name, total_rooms: rt.total_rooms, base_rate: rt.base_rate };
  }

  /** Nightly room revenue: prefer imported base (stable BAR), else current PMS rate, else category default. */
  function nightlyRoomAmount(
    r: { base_rate: number | null; current_rate: number | null },
    categoryDefault: number,
  ): number {
    const b = r.base_rate != null ? Number(r.base_rate) : NaN;
    if (Number.isFinite(b)) return b;
    const c = r.current_rate != null ? Number(r.current_rate) : NaN;
    if (Number.isFinite(c)) return c;
    return categoryDefault;
  }

  const firstDay = new Date(Date.UTC(year, month - 1, 1));
  const firstWeekday = firstDay.getUTCDay();
  const monthName = formatUtcMonthYear(year, month);

  const days: Record<string, CalendarDay> = {};

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${pad2(month)}-${pad2(d)}`;
    const dayDate = new Date(Date.UTC(year, month - 1, d));
    const weekday = WEEKDAY_NAMES[dayDate.getUTCDay()];

    const dayReservations = (reservations ?? []).filter((r) => r.stay_date === dateStr);

    const roomTypes: CalendarRoomType[] = rtList.map((rt) => {
      const matching = dayReservations.filter((r) => String(r.room_type_id) === String(rt.id));
      const booked = matching.length;
      const roomRevenue = matching.reduce(
        (s, r) => s + nightlyRoomAmount(r, rt.base_rate),
        0,
      );
      const adr = booked > 0 ? roomRevenue / booked : rt.base_rate;
      const occPct = rt.total_rooms > 0 ? Math.round((booked / rt.total_rooms) * 100) : 0;
      const published = publishedByKey.get(`${dateStr}|${String(rt.id)}`) ?? null;

      return {
        id: String(rt.id),
        name: rt.name,
        total_rooms: rt.total_rooms,
        occupancy_pct: occPct,
        booked,
        rate: Math.round(adr * 100) / 100,
        revenue: Math.round(roomRevenue * 100) / 100,
        current_price: published,
        current_rate: published,
      };
    });

    const totalRooms = roomTypes.reduce((s, rt) => s + rt.total_rooms, 0);
    const totalBooked = roomTypes.reduce((s, rt) => s + rt.booked, 0);
    const totalRevenue = roomTypes.reduce((s, rt) => s + rt.revenue, 0);
    const revpar = computeRevpar(revenueByDate.get(dateStr) ?? 0, totalRoomsProperty);

    days[String(d)] = {
      occupancy_pct: totalRooms > 0 ? Math.round((totalBooked / totalRooms) * 100) : 0,
      booked: totalBooked,
      total: totalRooms,
      revenue: Math.round(totalRevenue * 100) / 100,
      weekday,
      room_types: roomTypes,
      revpar,
      color: colorForRevpar(revpar, dateStr < todayStr ? scale.past : scale.future),
    };
  }

  return {
    year,
    month,
    month_name: monthName,
    days_in_month: daysInMonth,
    first_weekday: firstWeekday,
    thresholds: { ...THRESHOLDS, ...scaleToThresholds(scale) },
    range,
    days,
  };
}
