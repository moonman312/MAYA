/**
 * Realistic past years of bookings for the tests of the last onboarding
 * question (rate-moves.ts): a rate plan with weekday, weekend and summer
 * rates, nights that fill over their booking window, and an owner whose
 * price for each booking depends on how full the night already was and how
 * far ahead the guest booked.
 */
import type { RateHistoryRow } from "../../../../supabase/functions/_shared/onboarding/rate-moves";

export const TODAY = "2026-09-28";
const DAY_MS = 86_400_000;

/** Deterministic, so a failure is the same failure every run. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export type RoomType = { id: string; rooms: number; weekday: number; weekend: number };

/** The owner's rate plan: weekday and weekend rates, 30% more in June to August. */
export function planRate(rt: RoomType, night: string): number {
  const d = new Date(`${night}T00:00:00Z`);
  const weekend = d.getUTCDay() === 5 || d.getUTCDay() === 6;
  const summer = d.getUTCMonth() >= 5 && d.getUTCMonth() <= 7;
  return (weekend ? rt.weekend : rt.weekday) * (summer ? 1.3 : 1);
}

export type Ctx = { plan: number; full: number; daysAhead: number; weekend: boolean; rand: () => number };

/**
 * A past year of bookings. Each night books `occupancy` of its rooms, each
 * booking a room type with rooms left and a lead time drawn from `lead`, and
 * pays whatever `price` says given how full the night already was (rooms
 * booked on earlier days) and how far ahead it booked.
 */
export function year(opts: {
  types: RoomType[];
  occupancy: (weekend: boolean, month: number, rand: () => number) => number;
  lead: (rand: () => number) => number;
  price: (ctx: Ctx) => number;
  seed: number;
}): { rows: RateHistoryRow[]; rooms: number } {
  const rand = rng(opts.seed);
  const rooms = opts.types.reduce((s, t) => s + t.rooms, 0);
  const rows: RateHistoryRow[] = [];
  const today = Date.parse(`${TODAY}T00:00:00Z`);
  for (let back = 365; back >= 1; back -= 1) {
    const night = ymd(today - back * DAY_MS);
    const d = new Date(`${night}T00:00:00Z`);
    const weekend = d.getUTCDay() === 5 || d.getUTCDay() === 6;
    const target = Math.min(rooms, Math.round(rooms * opts.occupancy(weekend, d.getUTCMonth(), rand)));
    const left = new Map(opts.types.map((t) => [t.id, t.rooms]));
    const bookings: Array<{ type: RoomType; daysAhead: number }> = [];
    for (let i = 0; i < target; i += 1) {
      const open = opts.types.filter((t) => left.get(t.id)! > 0);
      const type = open[Math.floor(rand() * open.length)];
      left.set(type.id, left.get(type.id)! - 1);
      bookings.push({ type, daysAhead: opts.lead(rand) });
    }
    bookings.sort((a, b) => b.daysAhead - a.daysAhead);
    let bookedBefore = 0;
    for (let i = 0; i < bookings.length; ) {
      let j = i;
      while (j < bookings.length && bookings[j].daysAhead === bookings[i].daysAhead) j += 1;
      for (let k = i; k < j; k += 1) {
        const b = bookings[k];
        const plan = planRate(b.type, night);
        const rate = opts.price({ plan, full: bookedBefore / rooms, daysAhead: b.daysAhead, weekend, rand });
        rows.push({
          stay_date: night,
          booking_date: ymd(Date.parse(`${night}T00:00:00Z`) - b.daysAhead * DAY_MS),
          room_type_id: b.type.id,
          rate: Math.round(rate * 100) / 100,
        });
      }
      bookedBefore += j - i;
      i = j;
    }
  }
  return { rows, rooms };
}

export const INN: RoomType[] = [
  { id: "std", rooms: 14, weekday: 150, weekend: 190 },
  { id: "suite", rooms: 6, weekday: 280, weekend: 340 },
];

/** Busy in summer and on weekends, quiet in winter. */
export const seasonal = (weekend: boolean, month: number, rand: () => number) => {
  const high = month >= 5 && month <= 8;
  const base = high ? (weekend ? 0.92 : 0.8) : weekend ? 0.7 : 0.55;
  return Math.max(0.2, Math.min(1, base + (rand() - 0.5) * 0.3));
};
/** Most guests book within a month, a few up to two months ahead. */
export const usualLead = (rand: () => number) => Math.floor(rand() * rand() * 60);
