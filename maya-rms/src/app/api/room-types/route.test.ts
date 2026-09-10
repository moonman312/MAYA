import { describe, expect, it } from "vitest";
import { fallbackSeed } from "./route";

describe("fallbackSeed: the starting price when nothing is published yet", () => {
  it("uses the midpoint when the owner set real guardrails", () => {
    expect(fallbackSeed(100, 300)).toBe(200);
  });

  it("refuses the midpoint of MAYA's no-limit default", () => {
    // floor 1 / ceiling 99999.99 is what an unconstrained room type carries.
    // Its midpoint is $50,000, which would open the simulator on nonsense.
    expect(fallbackSeed(1, 99999.99)).toBe(1);
  });

  it("holds the line exactly at ten times the floor", () => {
    expect(fallbackSeed(100, 1000)).toBe(550);
    expect(fallbackSeed(100, 1000.01)).toBe(100);
  });

  it("never returns zero or a negative, whatever the guardrails say", () => {
    expect(fallbackSeed(0, 0)).toBe(1);
    expect(fallbackSeed(-50, 200)).toBe(1);
  });
});
