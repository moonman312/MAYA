import { describe, expect, it } from "vitest";
import { classifyPmsHealth } from "./health";

describe("classifyPmsHealth", () => {
  it("returns unknown with a null success rate when there is no traffic", () => {
    expect(classifyPmsHealth(0, 0)).toEqual({
      state: "unknown",
      successRate: null,
      total: 0,
      failures: 0,
    });
  });

  it("is healthy at a 98% success rate or better", () => {
    expect(classifyPmsHealth(100, 2).state).toBe("healthy");
    expect(classifyPmsHealth(50, 1).state).toBe("healthy");
    expect(classifyPmsHealth(10, 0)).toEqual({
      state: "healthy",
      successRate: 1,
      total: 10,
      failures: 0,
    });
  });

  it("is degraded between 80% and 98%", () => {
    expect(classifyPmsHealth(100, 3).state).toBe("degraded");
    expect(classifyPmsHealth(100, 20).state).toBe("degraded");
    expect(classifyPmsHealth(5, 1).state).toBe("degraded");
  });

  it("is down below 80%", () => {
    expect(classifyPmsHealth(100, 21).state).toBe("down");
    expect(classifyPmsHealth(4, 1).state).toBe("down");
    expect(classifyPmsHealth(3, 3).state).toBe("down");
  });

  it("reports the raw counts alongside the computed rate", () => {
    expect(classifyPmsHealth(200, 10)).toEqual({
      state: "degraded",
      successRate: 0.95,
      total: 200,
      failures: 10,
    });
  });
});
