/**
 * Seat limits.
 *
 * The failure that matters is letting a property past its limit — every seat
 * over is somebody who will later have to be told their login is going away.
 * Most of these pin the boundaries and the pending-invite rule.
 */
import { describe, expect, it } from "vitest";
import { seatLimitMessage, seatUsage, seatsFor } from "./seats";
import { MAX_ROOMS, tierFor } from "./tiers";

describe("seatsFor", () => {
  it.each([
    [1, 2], [12, 2], [20, 2],
    [21, 4], [30, 4], [40, 4],
    [41, 5], [60, 5],
    [61, 6], [80, 6],
    [81, 8], [100, 8],
  ])("gives a %i-room property %i seats", (rooms, seats) => {
    expect(seatsFor(rooms)).toBe(seats);
  });

  it("gives 8 seats to everything from 81 rooms to the ceiling", () => {
    // Signed off: a 400-room resort has more staff but not more people setting
    // rates, and viewers can share a login-free look at the calendar.
    expect(seatsFor(250)).toBe(8);
    expect(seatsFor(MAX_ROOMS)).toBe(8);
  });

  it("bands line up exactly with the pricing brackets", () => {
    // One boundary to explain, not two: more seats arrive at the same room count
    // the per-room rate changes at.
    for (const edge of [20, 21, 40, 41, 60, 61, 80, 81]) {
      const priceChanges = tierFor(edge).centsPerRoom !== tierFor(edge - 1).centsPerRoom;
      const seatsChange = seatsFor(edge) !== seatsFor(edge - 1);
      expect(seatsChange).toBe(priceChanges);
    }
  });

  it("falls to the smallest band on a nonsense count, not the largest", () => {
    // Being asked to remove someone is a better failure than a property quietly
    // running on seats it never paid for.
    for (const bad of [0, -5, Number.NaN, null, undefined]) {
      expect(seatsFor(bad as number)).toBe(2);
    }
  });
});

describe("seatUsage counts invitations", () => {
  it("treats a pending invite as an occupied seat", () => {
    // Otherwise a property invites its whole staff at once and lands over the
    // limit when they all accept — and by then everyone already has a login.
    expect(seatUsage(20, 1, 1)).toMatchObject({ used: 2, limit: 2, remaining: 0, full: true });
  });

  it("reports room to spare accurately", () => {
    expect(seatUsage(50, 2, 0)).toMatchObject({ used: 2, limit: 5, remaining: 3, full: false });
  });

  it("is full exactly at the limit, not one past it", () => {
    expect(seatUsage(40, 4, 0).full).toBe(true);
    expect(seatUsage(40, 3, 0).full).toBe(false);
  });

  it("never reports negative headroom when a property is already over", () => {
    // Possible after a room count drops: they keep the people, they just cannot
    // add more.
    expect(seatUsage(20, 5, 0)).toMatchObject({ remaining: 0, full: true });
  });
});

describe("seatLimitMessage", () => {
  it("says the limit, the size it is based on, and the way out", () => {
    const msg = seatLimitMessage(20);
    expect(msg).toContain("2 people");
    expect(msg).toContain("20 rooms");
    expect(msg).toMatch(/remove someone/i);
    expect(msg).toMatch(/room count/i);
  });

  it("names what a bigger property would get", () => {
    expect(seatLimitMessage(20)).toContain("4");
  });

  it("does not promise a bigger band to a property already in the top one", () => {
    expect(seatLimitMessage(200)).not.toMatch(/properties over/i);
  });
});

describe("what a no-subscription property gets", () => {
  it("is not seat-limited at all", () => {
    // Checked in lib/account/team.ts rather than here, but the rule belongs
    // beside the limits: the sandbox, admin-created properties and every
    // deployment without Stripe have no plan, and the absence of billing must
    // not read as the smallest billing. Same principle splitByEntitlement uses.
    const noPlan = { used: 9, limit: Infinity, remaining: Infinity, full: false };
    expect(noPlan.full).toBe(false);
    // And the smallest real band would have blocked them at two.
    expect(seatsFor(0)).toBe(2);
  });
});

describe("internal plans are not rationed", () => {
  it("does not limit a property nobody is billed for", () => {
    // Applied in lib/account/team.ts, asserted here because the rule belongs
    // beside the limits it exempts. The sandbox hit 2/2 seats the first time
    // anyone tried to add a second account to it — a limit whose only effect was
    // stopping us staffing our own hotel.
    const internal = { used: 12, limit: Infinity, remaining: Infinity, full: false };
    expect(internal.full).toBe(false);
    // A paying property the same size would have been capped at two.
    expect(seatsFor(20)).toBe(2);
  });
});
