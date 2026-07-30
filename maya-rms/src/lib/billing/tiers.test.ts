import { describe, expect, it } from "vitest";
import {
  ANNUAL_DISCOUNT_PCT,
  MAX_ROOMS,
  TIERS,
  annualDiscountPct,
  formatUsd,
  isBillableRoomCount,
  priceCents,
  tierFor,
} from "./tiers";

describe("monthly price is a step function, matching what Stripe was told", () => {
  // These are the numbers verified against the real Stripe volume-tier price;
  // they are the contract between this table and scripts/stripe-bootstrap.mts.
  const CASES: [rooms: number, dollars: number][] = [
    [1, 5.5],
    [5, 27.5],
    [20, 110],
    [21, 105],
    [40, 200],
    [41, 164],
    [60, 240],
    [61, 183],
    [80, 240],
    [81, 202.5],
    [100, 250],
    [500, 1250],
  ];

  for (const [rooms, dollars] of CASES) {
    it(`${rooms} rooms bills ${dollars}/mo`, () => {
      expect(priceCents(rooms, "month")).toBe(Math.round(dollars * 100));
    });
  }

  it("keeps the bracket inversions rather than smoothing them", () => {
    // A bigger property paying less in total is the intended, signed-off shape
    // of a step function. If someone "fixes" this into graduated pricing these
    // assertions are what should stop them.
    expect(priceCents(21, "month")).toBeLessThan(priceCents(20, "month"));
    expect(priceCents(61, "month")).toBeLessThan(priceCents(60, "month"));
    expect(priceCents(81, "month")).toBeLessThan(priceCents(80, "month"));
  });

  it("has no floor — a tiny property pays its tiny bill", () => {
    expect(priceCents(5, "month")).toBe(2750);
  });
});

describe("annual discounts every bracket except the smallest", () => {
  it("gives the first bracket no discount, so the UI must not imply one", () => {
    expect(annualDiscountPct(1)).toBe(0);
    expect(annualDiscountPct(20)).toBe(0);
    expect(priceCents(20, "year")).toBe(priceCents(20, "month") * 12);
  });

  it("gives every larger bracket the full discount", () => {
    for (const rooms of [21, 40, 41, 60, 61, 80, 81, 100, 500]) {
      expect(annualDiscountPct(rooms)).toBe(ANNUAL_DISCOUNT_PCT);
      const full = priceCents(rooms, "month") * 12;
      expect(priceCents(rooms, "year")).toBe(Math.round((full * 90) / 100));
    }
  });

  it("puts the discount edge on the bracket edge", () => {
    // 20 and 21 straddle both the price bracket and the discount rule; keeping
    // them aligned is why one room count can decide both.
    expect(annualDiscountPct(20)).toBe(0);
    expect(annualDiscountPct(21)).toBe(ANNUAL_DISCOUNT_PCT);
  });
});

describe("tierFor", () => {
  it("puts a boundary count in the bracket it names", () => {
    expect(tierFor(20).centsPerRoom).toBe(550);
    expect(tierFor(21).centsPerRoom).toBe(500);
    expect(tierFor(80).centsPerRoom).toBe(300);
    expect(tierFor(81).centsPerRoom).toBe(250);
  });

  it("covers every count up to the cap with no gaps", () => {
    for (let rooms = 1; rooms <= MAX_ROOMS; rooms++) {
      expect(tierFor(rooms)).toBeDefined();
      expect(priceCents(rooms, "month")).toBeGreaterThan(0);
    }
  });

  it("tops out at the last bracket rather than falling off the end", () => {
    expect(tierFor(MAX_ROOMS)).toBe(TIERS[TIERS.length - 1]);
  });
});

describe("isBillableRoomCount", () => {
  it("takes whole counts inside the cap", () => {
    expect(isBillableRoomCount(1)).toBe(true);
    expect(isBillableRoomCount(MAX_ROOMS)).toBe(true);
  });

  it("refuses everything a room count cannot be", () => {
    for (const bad of [0, -5, 1.5, MAX_ROOMS + 1, NaN, Infinity, "20", null, undefined, {}]) {
      expect(isBillableRoomCount(bad)).toBe(false);
    }
  });
});

describe("formatUsd", () => {
  it("drops cents when there are none and keeps them when there are", () => {
    expect(formatUsd(11000)).toBe("$110");
    expect(formatUsd(20250)).toBe("$202.50");
    expect(formatUsd(125000)).toBe("$1,250");
  });
});
