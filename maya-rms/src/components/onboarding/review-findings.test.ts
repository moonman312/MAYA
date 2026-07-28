import { describe, expect, it } from "vitest";
import { describeFinding } from "@/components/onboarding/review-findings";

function finding(kind: string, payload: Record<string, unknown>) {
  return {
    id: "f1",
    kind,
    status: "proposed",
    payload,
    created_at: "2026-01-01T00:00:00Z",
  };
}

describe("describeFinding", () => {
  it("marks zero_rate_rows as acknowledge-only with reassurance copy", () => {
    const c = describeFinding(finding("zero_rate_rows", { count: 42 }));
    expect(c.acknowledgeOnly).toBe(true);
    expect(c.confirmLabel).toBe("Got it");
    expect(c.body.endsWith("Nothing you have to do — we'll ignore them for the purpose of this analysis.")).toBe(true);
  });

  it("marks unmapped_room_type as acknowledge-only with reassurance copy", () => {
    const c = describeFinding(finding("unmapped_room_type", { count: 7 }));
    expect(c.acknowledgeOnly).toBe(true);
    expect(c.confirmLabel).toBe("Got it");
    expect(c.body).toMatch(/Nothing you have to do/);
  });

  it("leaves actionable kinds with confirm/dismiss pairs", () => {
    const kinds: Array<[string, Record<string, unknown>]> = [
      ["closed_period", { start_date: "2025-01-01", end_date: "2025-01-10", days: 10 }],
      ["suspect_room_type", { name: "Spa Slot", reasons: ["no beds"] }],
      ["duplicate_room_type", { name: "Double" }],
      ["rate_outlier", { name: "Suite", max_rate: 9999, median_rate: 200 }],
      ["guardrail_suggestion", { field: "floor_price", room_type_name: "Suite", rationale: "Rates dip low.", suggested: 120 }],
    ];
    for (const [kind, payload] of kinds) {
      const c = describeFinding(finding(kind, payload));
      expect(c.acknowledgeOnly).toBeUndefined();
      expect(c.dismissLabel.length).toBeGreaterThan(0);
    }
  });

  it("keeps the fallback for unknown kinds intact", () => {
    const c = describeFinding(finding("mystery_kind", { foo: "bar" }));
    expect(c.acknowledgeOnly).toBeUndefined();
    expect(c.confirmLabel).toBe("Confirm");
    expect(c.dismissLabel).toBe("Dismiss");
  });
});
