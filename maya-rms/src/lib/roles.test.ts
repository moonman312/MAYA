/**
 * Staff and Viewer used to be two roles granting the same thing — identical
 * descriptions, and "staff" was never checked for anywhere outside this file.
 * Merged into Viewer; these pin that the merge actually happened rather than
 * just being hidden behind a shorter picker.
 */
import { describe, expect, it } from "vitest";
import { HOTEL_ROLES, isHotelRole, roleLabel, roleRank, rolesAssignableBy } from "./roles";

// Widened to `string`, not the HotelRole literal union: the point of every test
// below is that "staff" is no longer one of the values that type can hold, so
// comparing against the literal directly would fail to compile rather than
// exercise the runtime check — which is itself the sign the merge is real.
const STAFF: string = "staff";

describe("staff no longer exists as a distinct role", () => {
  it("is not offered anywhere the product presents roles", () => {
    expect(HOTEL_ROLES.some((r) => (r.key as string) === STAFF)).toBe(false);
  });

  it("is not recognized as a valid role", () => {
    expect(isHotelRole("staff")).toBe(false);
  });

  it("ranks as unknown rather than inheriting the old rank-10 slot", () => {
    // -1, not 10 — a lingering "staff" value (an old DB row, a stale client)
    // must read as beneath Viewer, never as a role with its own standing.
    expect(roleRank("staff")).toBe(-1);
    expect(roleRank("staff")).toBeLessThan(roleRank("viewer"));
  });

  it("falls back to the raw string rather than a stale label", () => {
    expect(roleLabel("staff")).toBe("staff");
  });

  it("is never handed out, even to a platform admin", () => {
    expect(
      rolesAssignableBy(null, { isPlatformAdmin: true }).some((r) => (r.key as string) === STAFF),
    ).toBe(
      false,
    );
  });
});

describe("the surviving role set", () => {
  it("has exactly four roles now, highest rank first", () => {
    expect(HOTEL_ROLES.map((r) => r.key)).toEqual([
      "hotel_admin",
      "general_manager",
      "revenue_manager",
      "viewer",
    ]);
  });

  it("gives every role a description that earns the merge — no two are identical", () => {
    // The whole reason for the merge: two roles should not say the same thing.
    // Pins it so a future addition can't quietly reintroduce the problem.
    const descriptions = HOTEL_ROLES.map((r) => r.description);
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });
});
