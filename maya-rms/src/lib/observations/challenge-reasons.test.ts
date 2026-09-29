/**
 * The words on the "Not a fair comparison?" picker. The docs quote them, so a
 * rename has to land in both places.
 */
import { describe, expect, it } from "vitest";
import { CHALLENGE_REASONS, challengeReasonLabel } from "@/lib/observations/reinforcement";

describe("challenge reason labels", () => {
  it("calls a missing holiday one that isn't on MAYA's list", () => {
    expect(CHALLENGE_REASONS.find((r) => r.key === "holiday")?.label).toBe("Holiday Not on MAYA's List");
    expect(challengeReasonLabel("holiday")).toBe("Holiday Not on MAYA's List");
  });
});
