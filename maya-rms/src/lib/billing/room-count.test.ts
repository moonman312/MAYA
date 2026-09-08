/**
 * Billing for rooms actually run.
 *
 * The dangerous direction here is a FALSE accusation: telling a hotel it is
 * underpaying, and then charging it more, on the strength of a measurement that
 * was really just missing data. Most of these pin that down.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  compareRooms,
  graceDaysLeft,
  graceExpired,
  measureRooms,
  recordRoomCount,
  ROOM_SHORTFALL_GRACE_DAYS,
} from "./room-count";

const NOW = new Date("2026-07-30T12:00:00Z");

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

function fakeAdmin(opts: {
  roomTypes?: { name: string; display_name?: string | null; total_rooms: number }[] | null;
  roomTypesError?: string;
  subscription?: { billed_rooms: number; room_shortfall_since: string | null } | null;
}) {
  const patches: Record<string, unknown>[] = [];
  const admin = {
    from(table: string) {
      if (table === "room_types") {
        return {
          select: () => ({
            eq: () => ({
              eq: async () =>
                opts.roomTypesError
                  ? { data: null, error: { message: opts.roomTypesError } }
                  : { data: opts.roomTypes ?? [], error: null },
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: opts.subscription ?? null, error: null }) }),
        }),
        update: (patch: Record<string, unknown>) => ({
          eq: async () => {
            patches.push(patch);
            return { error: null };
          },
        }),
      };
    },
  };
  return { admin: admin as unknown as SupabaseClient, patches };
}

describe("measureRooms only counts places people sleep", () => {
  it("adds up ordinary bedrooms", async () => {
    const { admin } = fakeAdmin({
      roomTypes: [{ name: "King Room", total_rooms: 20 }, { name: "Double Queen", total_rooms: 40 }],
    });
    expect((await measureRooms(admin, "h1")).billable).toBe(60);
  });

  it("does not bill a 20-room inn for its pickleball courts", async () => {
    // The exact scenario: every PMS models a court as a bookable room type,
    // because sellable inventory is the only primitive it has. Counting them
    // would charge this property for 26 rooms it does not have.
    const { admin } = fakeAdmin({
      roomTypes: [
        { name: "King Room", total_rooms: 20 },
        { name: "Pickleball Court", total_rooms: 5 },
        { name: "Grand Ballroom", total_rooms: 1 },
      ],
    });
    const m = await measureRooms(admin, "h1");
    expect(m.billable).toBe(20);
    expect(m.excluded.map((e) => e.name)).toEqual(["Pickleball Court", "Grand Ballroom"]);
  });

  it.each([
    "Parking Space", "Boardroom", "Conference Room B", "Spa Treatment",
    "Massage 60min", "Day Use", "Resort Fee", "Kayak Rental", "Gift Shop Credit",
  ])("excludes %j", async (name) => {
    const { admin } = fakeAdmin({
      roomTypes: [{ name: "King Room", total_rooms: 10 }, { name, total_rooms: 4 }],
    });
    expect((await measureRooms(admin, "h1")).billable).toBe(10);
  });

  it.each(["Cabana Suite", "Spa Suite", "Poolside King", "Ballroom Suite", "Golf View Room"])(
    "still bills for %j, which is a real bedroom",
    async (name) => {
      // The weak keywords only damn a name with no bedroom noun in it. Getting
      // this backwards would silently under-bill every resort.
      const { admin } = fakeAdmin({ roomTypes: [{ name, total_rooms: 12 }] });
      expect((await measureRooms(admin, "h1")).billable).toBe(12);
    },
  );

  it("reads the display name too, since PMSes differ about which one is useful", async () => {
    const { admin } = fakeAdmin({
      roomTypes: [
        { name: "RT-001", display_name: "Pickleball Court", total_rooms: 5 },
        { name: "RT-002", display_name: "King Room", total_rooms: 20 },
      ],
    });
    expect((await measureRooms(admin, "h1")).billable).toBe(20);
  });

  it("returns null, not zero, when there is nothing to count", async () => {
    // A property mid-import genuinely has no measurement. Calling that "0 rooms"
    // would read as the largest possible over-billing and could cut a real bill
    // to nothing.
    const { admin } = fakeAdmin({ roomTypes: [] });
    expect((await measureRooms(admin, "h1")).billable).toBeNull();
  });

  it("returns null when a property is nothing but non-rooms", async () => {
    const { admin } = fakeAdmin({ roomTypes: [{ name: "Parking", total_rooms: 30 }] });
    expect((await measureRooms(admin, "h1")).billable).toBeNull();
  });

  it("returns null on a read error rather than guessing", async () => {
    const { admin } = fakeAdmin({ roomTypesError: "connection reset" });
    expect((await measureRooms(admin, "h1")).billable).toBeNull();
  });
});

describe("compareRooms", () => {
  it("counts a single missing room as a shortfall", async () => {
    // The price is rooms times a per-room rate, so one room is real money every
    // month. There is deliberately no tolerance band inside which underpaying is
    // free.
    expect(compareRooms(41, 40)).toEqual({ kind: "short", measured: 41, billed: 40, shortBy: 1 });
  });

  it("names the full gap on a big one", () => {
    expect(compareRooms(60, 20)).toEqual({ kind: "short", measured: 60, billed: 20, shortBy: 40 });
  });

  it("treats paying for more as over, not as a problem to enforce", () => {
    expect(compareRooms(30, 40)).toEqual({ kind: "over", measured: 30, billed: 40, overBy: 10 });
  });

  it("is ok when they match", () => {
    expect(compareRooms(40, 40)).toEqual({ kind: "ok", measured: 40, billed: 40 });
  });

  it("never accuses anyone on a missing measurement", () => {
    expect(compareRooms(null, 40)).toEqual({ kind: "unknown", reason: "no_room_data" });
  });

  it("says nothing when there is no billed count to compare against", () => {
    expect(compareRooms(60, null)).toEqual({ kind: "unknown", reason: "not_measured" });
    expect(compareRooms(60, 0)).toEqual({ kind: "unknown", reason: "not_measured" });
  });
});

describe("recordRoomCount runs the grace clock", () => {
  it("starts the clock the first time a property is seen short", async () => {
    const { admin, patches } = fakeAdmin({
      roomTypes: [{ name: "King Room", total_rooms: 60 }],
      subscription: { billed_rooms: 20, room_shortfall_since: null },
    });
    const verdict = await recordRoomCount(admin, "h1", NOW);
    expect(verdict).toMatchObject({ kind: "short", shortBy: 40 });
    expect(patches[0]).toMatchObject({
      measured_rooms: 60,
      room_shortfall_since: NOW.toISOString(),
    });
  });

  it("does NOT restart the clock on later syncs", async () => {
    // This is the one that decides whether the deadline ever arrives. The sync
    // runs every few minutes; pushing the start forward each time would mean the
    // grace period never expires and nothing is ever corrected.
    const started = "2026-07-25T12:00:00Z";
    const { admin, patches } = fakeAdmin({
      roomTypes: [{ name: "King Room", total_rooms: 60 }],
      subscription: { billed_rooms: 20, room_shortfall_since: started },
    });
    await recordRoomCount(admin, "h1", NOW);
    expect(patches[0]).not.toHaveProperty("room_shortfall_since");
  });

  it("clears the clock once the shortfall is resolved", async () => {
    const { admin, patches } = fakeAdmin({
      roomTypes: [{ name: "King Room", total_rooms: 60 }],
      subscription: { billed_rooms: 60, room_shortfall_since: "2026-07-25T12:00:00Z" },
    });
    expect(await recordRoomCount(admin, "h1", NOW)).toMatchObject({ kind: "ok" });
    expect(patches[0]).toMatchObject({ room_shortfall_since: null });
  });

  it("writes nothing at all when the measurement is missing", async () => {
    // Otherwise a hotel mid-import would have its clock started on no evidence.
    const { admin, patches } = fakeAdmin({
      roomTypes: [],
      subscription: { billed_rooms: 20, room_shortfall_since: null },
    });
    expect(await recordRoomCount(admin, "h1", NOW)).toEqual({ kind: "unknown", reason: "no_room_data" });
    expect(patches).toHaveLength(0);
  });

  it("leaves properties with no subscription alone", async () => {
    // The sandbox and admin-created properties have no billing to be wrong about.
    const { admin, patches } = fakeAdmin({ roomTypes: [{ name: "King Room", total_rooms: 60 }], subscription: null });
    expect(await recordRoomCount(admin, "h1", NOW)).toEqual({ kind: "unknown", reason: "not_measured" });
    expect(patches).toHaveLength(0);
  });

  it("records an over-billing measurement without starting any clock", async () => {
    const { admin, patches } = fakeAdmin({
      roomTypes: [{ name: "King Room", total_rooms: 30 }],
      subscription: { billed_rooms: 40, room_shortfall_since: null },
    });
    expect(await recordRoomCount(admin, "h1", NOW)).toMatchObject({ kind: "over", overBy: 10 });
    expect(patches[0]).toMatchObject({ measured_rooms: 30 });
    expect(patches[0]).not.toHaveProperty("room_shortfall_since");
  });
});

describe("the grace deadline", () => {
  const start = "2026-07-23T12:00:00Z";

  it("expires exactly on the boundary, not a day late", () => {
    const atBoundary = new Date(Date.parse(start) + ROOM_SHORTFALL_GRACE_DAYS * 86_400_000);
    expect(graceExpired(start, atBoundary)).toBe(true);
    expect(graceExpired(start, new Date(atBoundary.getTime() - 1000))).toBe(false);
  });

  it("is never expired for a property that is not short", () => {
    expect(graceExpired(null, NOW)).toBe(false);
  });

  it("does not expire on an unparseable timestamp", () => {
    // Failing open here means one uncorrected bill; failing closed would charge
    // someone off a value nobody can read.
    expect(graceExpired("not a date", NOW)).toBe(false);
  });

  it("counts down in whole days and floors at zero", () => {
    expect(graceDaysLeft(NOW.toISOString(), NOW)).toBe(ROOM_SHORTFALL_GRACE_DAYS);
    expect(graceDaysLeft("2026-07-01T12:00:00Z", NOW)).toBe(0);
    expect(graceDaysLeft(null, NOW)).toBe(ROOM_SHORTFALL_GRACE_DAYS);
  });
});
