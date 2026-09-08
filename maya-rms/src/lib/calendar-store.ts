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

/* ── Hotel history cache ──────────────────────────────────────── */

/**
 * The RevPAR series, closed periods, and navigable range are hotel-wide facts
 * that don't depend on which month is being viewed — but they were being
 * recomputed on every month navigation and every live refresh. Cache them
 * briefly per hotel so Prev/Next clicks and realtime-triggered reloads only
 * pay for the visible month's queries.
 *
 * TTL trade-off: colors may lag a real booking by up to 5 minutes (the
 * booked counts and revenue on the visible month always come from fresh
 * queries — only the threshold context ages). Kept deliberately short
 * because future-day thresholds are judged against on-the-books peers,
 * a distribution that genuinely moves as bookings land.
 */
export type HotelHistory = {
  revenueByDate: Map<string, number>;
  minStayDate: string | null;
  maxStayDate: string | null;
  closedPeriods: { start_date: string; end_date: string }[];
  ppMin: string | null;
  ppMax: string | null;
};

const HISTORY_TTL_MS = 5 * 60 * 1000;

type TtlEntry<T> = { expiresAt: number; value: T };

/**
 * Tiny keyed TTL cache with an injectable clock (exported for tests).
 * Stampede-proof: concurrent misses for the same key share one loader call
 * instead of each firing their own — without this, a burst of calendar
 * requests hitting an expired entry would all reload the full history at
 * once (the classic cache-stampede failure).
 */
export function createTtlCache<T>(ttlMs: number, now: () => number = Date.now) {
  const entries = new Map<string, TtlEntry<T>>();
  const inFlight = new Map<string, Promise<T>>();
  return {
    async getOrLoad(key: string, loader: () => Promise<T>): Promise<T> {
      const hit = entries.get(key);
      if (hit && hit.expiresAt > now()) return hit.value;
      const pending = inFlight.get(key);
      if (pending) return pending;
      const p = loader()
        .then((value) => {
          entries.set(key, { expiresAt: now() + ttlMs, value });
          return value;
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, p);
      return p;
    },
    clear(): void {
      entries.clear();
    },
  };
}

const historyCache = createTtlCache<HotelHistory>(HISTORY_TTL_MS);

/** Exported so tests (or future cache-busting hooks) can force a recompute. */
export function clearCalendarHistoryCache(): void {
  historyCache.clear();
}

async function loadHotelHistory(
  supabase: SupabaseClient,
  hotelId: string,
): Promise<HotelHistory> {
  // Hotel-wide nightly revenue (sum of current_rate per stay date) — the
  // RevPAR series day colors are judged against. Grouped in Postgres
  // (one row per distinct stay date) instead of pulling every reservation
  // row into Node — a mature property can have tens of thousands of
  // reservation rows but only a few hundred/thousand distinct stay dates.
  //
  // Paged because PostgREST caps ANY response (RPCs included) at its
  // "Max rows" setting — typically 1000. Three years of history is already
  // ~1100 distinct dates, and the rows a single call would silently drop
  // are the NEWEST ones: exactly the future days the color scale needs.
  const revenueByDate = new Map<string, number>();
  let minStayDate: string | null = null;
  let maxStayDate: string | null = null;
  const PAGE = 1000;
  for (let from = 0, guard = 0; guard < 100; from += PAGE, guard++) {
    const { data: seriesRows, error: seriesErr } = await supabase
      .rpc("calendar_daily_revenue", { p_hotel_id: hotelId })
      .range(from, from + PAGE - 1);
    if (seriesErr) throw new Error(seriesErr.message);
    const rows = (seriesRows ?? []) as { stay_date: string; revenue: number | string | null }[];
    for (const row of rows) {
      const stayDate = String(row.stay_date);
      const amount = Number(row.revenue ?? 0);
      revenueByDate.set(stayDate, Number.isFinite(amount) ? amount : 0);
      if (minStayDate === null || stayDate < minStayDate) minStayDate = stayDate;
      if (maxStayDate === null || stayDate > maxStayDate) maxStayDate = stayDate;
    }
    if (rows.length < PAGE) break;
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

  return {
    revenueByDate,
    minStayDate,
    maxStayDate,
    closedPeriods,
    ppMin: ppMinRow?.stay_date != null ? String(ppMinRow.stay_date) : null,
    ppMax: ppMaxRow?.stay_date != null ? String(ppMaxRow.stay_date) : null,
  };
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

  const startDate = `${year}-${pad2(month)}-01`;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const endDate = `${year}-${pad2(month)}-${pad2(daysInMonth)}`;

  // Every query below depends only on hotelId, so they all fly at once —
  // this used to be a sequential chain, and each hop is a full round-trip
  // from the app server to Supabase.
  const [
    { data: hotelRow },
    { data: roomTypeRows },
    { data: reservations },
    { data: publishedPrices },
    history,
  ] = await Promise.all([
    supabase
      .from("hotels")
      .select("total_rooms_per_type, timezone")
      .eq("id", hotelId)
      .maybeSingle(),
    supabase
      .from("room_types")
      .select("id, name, total_rooms")
      .eq("hotel_id", hotelId)
      .eq("is_active", true)
      .order("name"),
    supabase
      .from("reservations")
      .select("stay_date, room_type_id, base_rate, current_rate")
      .eq("hotel_id", hotelId)
      .gte("stay_date", startDate)
      .lte("stay_date", endDate),
    // Engine-published prices (the current asking price after rules +
    // clamps). Absent until the first evaluation run, so the UI treats
    // null as "not priced yet".
    supabase
      .from("published_price")
      .select("stay_date, room_type_id, price")
      .eq("hotel_id", hotelId)
      .gte("stay_date", startDate)
      .lte("stay_date", endDate),
    // Hotel-wide history (RevPAR series, closures, navigable range) —
    // cached for a few minutes per hotel; see HotelHistory above.
    historyCache.getOrLoad(hotelId, () => loadHotelHistory(supabase, hotelId)),
  ]);

  const hotelFallbackRooms = hotelRow?.total_rooms_per_type ?? 100;
  const defaultBaseRate = 150;
  const todayStr = evalIsoToHotelDateString(new Date().toISOString(), hotelRow?.timezone ?? "UTC");

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

  const publishedByKey = new Map<string, number>();
  for (const p of publishedPrices ?? []) {
    const price = p.price != null ? Number(p.price) : NaN;
    if (Number.isFinite(price)) {
      publishedByKey.set(`${p.stay_date}|${String(p.room_type_id)}`, price);
    }
  }

  const { revenueByDate, closedPeriods } = history;

  const totalRoomsProperty = rtList.reduce((s, rt) => s + rt.total_rooms, 0);

  // Split/scale are recomputed per request: they depend on "today", which the
  // cached series must not bake in (a cache entry can straddle midnight).
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

  const dateCandidates = [
    history.minStayDate,
    history.maxStayDate,
    history.ppMin,
    history.ppMax,
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
