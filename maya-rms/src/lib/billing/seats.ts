/**
 * How many people a property may have on its account.
 *
 * Scales with property size for the obvious reason: a 12-room inn is one owner
 * and a night manager, a 90-room hotel has a revenue team, a GM, and front desk
 * staff who need to see the calendar. Bands match the pricing brackets exactly,
 * so a property that crosses a boundary gets more seats at the same moment its
 * per-room rate changes and there is only one number to explain.
 */

import { MAX_ROOMS } from "./tiers";

/** Jake's table, by upper bound of the band. */
const SEAT_BANDS: readonly { maxRooms: number; seats: number }[] = [
  { maxRooms: 20, seats: 2 },
  { maxRooms: 40, seats: 4 },
  { maxRooms: 60, seats: 5 },
  { maxRooms: 80, seats: 6 },
  // The table Jake wrote stops at 100 rooms, but MAYA sells to 500. Extending
  // the last band rather than inventing figures nobody agreed to: a property
  // above 100 rooms gets the same 8 seats until someone decides otherwise. If
  // that turns out to be tight for a 400-room resort, this is the line to change.
  { maxRooms: MAX_ROOMS, seats: 8 },
];

/**
 * Seats included at this property size.
 *
 * A room count we cannot make sense of gets the smallest band rather than the
 * largest — being asked to remove somebody is a better failure than a property
 * quietly running on more seats than it pays for.
 */
export function seatsFor(rooms: number | null | undefined): number {
  const n = Number(rooms);
  if (!Number.isFinite(n) || n < 1) return SEAT_BANDS[0].seats;
  return (SEAT_BANDS.find((b) => n <= b.maxRooms) ?? SEAT_BANDS[SEAT_BANDS.length - 1]).seats;
}

export type SeatUsage = {
  /** Active members plus invitations not yet accepted. */
  used: number;
  limit: number;
  remaining: number;
  full: boolean;
};

/**
 * Pending invitations count against the limit.
 *
 * They are a seat someone is about to occupy, and not counting them lets a
 * property invite its whole staff at once and land over the limit the moment
 * they all accept — at which point the only fix is telling people who already
 * have logins that they don't.
 */
export function seatUsage(rooms: number, activeMembers: number, pendingInvites: number): SeatUsage {
  const limit = seatsFor(rooms);
  const used = activeMembers + pendingInvites;
  return { used, limit, remaining: Math.max(0, limit - used), full: used >= limit };
}

/** What to tell someone who has run out, including how to get more. */
export function seatLimitMessage(rooms: number): string {
  const limit = seatsFor(rooms);
  const next = SEAT_BANDS.find((b) => b.seats > limit);
  const more = next
    ? ` Properties over ${SEAT_BANDS.find((b) => b.seats === limit)!.maxRooms} rooms get ${next.seats}.`
    : "";
  return `Your plan covers ${limit} ${limit === 1 ? "person" : "people"} at ${rooms} rooms.${more} Remove someone first, or update your room count if the property has grown.`;
}

export { SEAT_BANDS };
