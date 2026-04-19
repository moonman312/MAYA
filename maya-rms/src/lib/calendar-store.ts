/**
 * Calendar data provider.
 *
 * When a Supabase client is supplied the function queries the reservations +
 * room_types tables.  Otherwise it generates deterministic demo data that
 * matches the Python legacy dashboard.
 */

import { ROOM_TYPES } from "@/lib/demo-data";
import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import type { CalendarDay, CalendarResponse, CalendarRoomType } from "@/types/domain";
import type { SupabaseClient } from "@supabase/supabase-js";

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const THRESHOLDS = { low: 60, high: 80 };

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

/* ── Demo / fallback calendar ─────────────────────────────────── */

function getCalendarDemo(year: number, month: number): CalendarResponse {
  const firstDay = new Date(Date.UTC(year, month - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const firstWeekday = firstDay.getUTCDay(); // 0 = Sunday
  const monthName = firstDay.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

  const days: Record<string, CalendarDay> = {};

  for (let d = 1; d <= daysInMonth; d++) {
    const dayDate = new Date(Date.UTC(year, month - 1, d));
    const weekday = WEEKDAY_NAMES[dayDate.getUTCDay()];

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
      };
    });

    const totalRooms = roomTypes.reduce((s, rt) => s + rt.total_rooms, 0);
    const totalBooked = roomTypes.reduce((s, rt) => s + rt.booked, 0);
    const totalRevenue = roomTypes.reduce((s, rt) => s + rt.revenue, 0);
    const occPct = totalRooms > 0 ? Math.round((totalBooked / totalRooms) * 100) : 0;

    days[String(d)] = {
      occupancy_pct: occPct,
      booked: totalBooked,
      total: totalRooms,
      revenue: Math.round(totalRevenue * 100) / 100,
      weekday,
      room_types: roomTypes,
    };
  }

  return {
    year,
    month,
    month_name: monthName,
    days_in_month: daysInMonth,
    first_weekday: firstWeekday,
    thresholds: THRESHOLDS,
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
    .select("total_rooms_per_type")
    .eq("id", hotelId)
    .maybeSingle();

  const hotelFallbackRooms = hotelRow?.total_rooms_per_type ?? 100;
  const defaultBaseRate = 150;

  const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const endDate = `${year}-${String(month).padStart(2, "0")}-${String(daysInMonth).padStart(2, "0")}`;

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
  const monthName = firstDay.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

  const days: Record<string, CalendarDay> = {};

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
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

      return {
        id: String(rt.id),
        name: rt.name,
        total_rooms: rt.total_rooms,
        occupancy_pct: occPct,
        booked,
        rate: Math.round(adr * 100) / 100,
        revenue: Math.round(roomRevenue * 100) / 100,
      };
    });

    const totalRooms = roomTypes.reduce((s, rt) => s + rt.total_rooms, 0);
    const totalBooked = roomTypes.reduce((s, rt) => s + rt.booked, 0);
    const totalRevenue = roomTypes.reduce((s, rt) => s + rt.revenue, 0);

    days[String(d)] = {
      occupancy_pct: totalRooms > 0 ? Math.round((totalBooked / totalRooms) * 100) : 0,
      booked: totalBooked,
      total: totalRooms,
      revenue: Math.round(totalRevenue * 100) / 100,
      weekday,
      room_types: roomTypes,
    };
  }

  return {
    year,
    month,
    month_name: monthName,
    days_in_month: daysInMonth,
    first_weekday: firstWeekday,
    thresholds: THRESHOLDS,
    days,
  };
}
