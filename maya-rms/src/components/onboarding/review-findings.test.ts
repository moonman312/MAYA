import { describe, expect, it } from "vitest";
import { describeFinding } from "@/components/onboarding/review-findings";
import { isCountingRoom, roomCountQuestion } from "@/components/room-type-settings";

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

  it("describes what confirming a suspect room type really does — out of the count, still priceable", () => {
    // Confirm writes counts_as_room = false; a rule that lists the type as
    // affected keeps pricing it. Promising "excluded from pricing" was a lie.
    const c = describeFinding(finding("suspect_room_type", { name: "Spa Slot", reasons: ["no beds"] }));
    expect(c.body).toContain("occupancy, RevPAR and the room count");
    expect(c.body).toContain("still be priced");
    expect(c.body).not.toContain("excludes it from pricing");
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

  it("gives removal cards a third, reversible option alongside remove/keep", () => {
    const c = describeFinding(
      finding("rule_suggestion", {
        suggestion_type: "remove_rule",
        rule_id: "pk1",
        rule_name: "Old pickup spike",
        rationale: "It overlaps the pace rules.",
      }),
    );
    expect(c.confirmLabel).toBe("Remove it");
    expect(c.keepLabel).toBe("Turn it off, keep it");
    expect(c.dismissLabel).toBe("Leave it running");
    // The body must explain the difference — deleting is permanent, pausing
    // is recoverable — or three buttons is just a guessing game.
    expect(c.body).toContain("re-enable");
  });

  it("only removal cards get the third option", () => {
    const kinds: Array<[string, Record<string, unknown>]> = [
      ["closed_period", { start_date: "2025-01-01", end_date: "2025-01-10", days: 10 }],
      ["suspect_room_type", { name: "Spa Slot", reasons: ["no beds"] }],
      ["rule_suggestion", { suggestion_type: "add_rule", spec: { name: "X" }, rationale: "r" }],
      ["guardrail_suggestion", { field: "floor_price", room_type_name: "Suite", rationale: "r", suggested: 120 }],
    ];
    for (const [kind, payload] of kinds) {
      expect(describeFinding(finding(kind, payload)).keepLabel).toBeUndefined();
    }
  });

  it("keeps the fallback for unknown kinds intact", () => {
    const c = describeFinding(finding("mystery_kind", { foo: "bar" }));
    expect(c.acknowledgeOnly).toBeUndefined();
    expect(c.confirmLabel).toBe("Confirm");
    expect(c.dismissLabel).toBe("Dismiss");
  });
});

describe("the room-count strip", () => {
  it("asks the question with the count, singular and plural", () => {
    expect(roomCountQuestion(3)).toBe("We're counting 3 room types as rooms — anything here that isn't?");
    expect(roomCountQuestion(1)).toBe("We're counting 1 room type as rooms — anything here that isn't?");
  });

  it("ticks everything the import didn't flag — null is ticked, only false is unticked", () => {
    expect(isCountingRoom({ counts_as_room: null })).toBe(true);
    expect(isCountingRoom({ counts_as_room: true })).toBe(true);
    expect(isCountingRoom({ counts_as_room: false })).toBe(false);
  });
});

describe("GoLiveConfirmation", () => {
  it("says what going live does, and links the Terms in a new tab", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { GoLiveConfirmation } = await import("@/components/onboarding/review-findings");
    const html = renderToStaticMarkup(createElement(GoLiveConfirmation));
    const text = html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'");
    expect(text).toBe(
      "Going live sends these rates to your PMS automatically. You're confirming you've reviewed your rules and limits (Terms 3.3).",
    );
    expect(html).toContain('href="https://www.get-maya.com/terms"');
    expect(html).toContain('target="_blank"');
    expect(html).toMatch(/>Terms<\/a>/);
  });
});
