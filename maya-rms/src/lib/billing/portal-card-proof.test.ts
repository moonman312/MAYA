import { describe, expect, it } from "vitest";
import { cardFate, mayaPlanFor, readProof, type ProofReading } from "./portal-card-proof";

describe("cardFate", () => {
  it("names what happened to a subscription's own card", () => {
    expect(cardFate("pm_fail", "pm_fail", "pm_new")).toBe("kept");
    expect(cardFate("pm_fail", null, "pm_new")).toBe("cleared");
    expect(cardFate("pm_fail", "pm_new", "pm_new")).toBe("moved");
    expect(cardFate("pm_fail", "pm_odd", "pm_new")).toBe("other");
  });
});

describe("readProof", () => {
  // A group: the overdue one on the failing card, the other on its own
  // Mastercard, no default before. The portal action made pm_new the default.
  const group: ProofReading = {
    control: "add_card",
    defaultCard: "pm_new",
    overdue: { before: "pm_fail", after: "pm_fail" },
    ownCard: { before: "pm_mc", after: "pm_mc" },
    overdueInvoice: "open",
  };
  const single: ProofReading = {
    control: "single_add_card",
    defaultCard: "pm_new",
    overdue: { before: "pm_fail", after: "pm_fail" },
    overdueInvoice: "open",
  };

  it("says nothing was proved when the default never changed", () => {
    const v = readProof({ ...group, defaultCard: null });
    expect(v.changeNeeded).toBe(false);
    expect(v.maya).toBeNull();
    expect(v.action).toContain("Nothing was proved");
  });

  it("calls for a change when the portal takes a property off its own card", () => {
    expect(readProof({ ...group, ownCard: { before: "pm_mc", after: null } }).changeNeeded).toBe(true);
    expect(readProof({ ...group, ownCard: { before: "pm_mc", after: "pm_new" } }).changeNeeded).toBe(true);
  });

  it("says MAYA moves nothing and pays nothing for a group the portal left alone: the documented exception", () => {
    // Not "MAYA moves it": with two different cards and no default, card-change.ts cannot tell the old card.
    const v = readProof(group);
    expect(mayaPlanFor(group)).toEqual({ overdue: "own_card", ownCard: "own_card", ambiguous: true });
    expect(v.changeNeeded).toBe(false);
    expect(v.maya).toContain("leaves the overdue subscription on the failing card and pays nothing");
    expect(v.maya).toContain("leaves the subscription on its own card alone");
    expect(v.action).toContain("documented exception");
    expect(v.action).not.toContain("MAYA's webhook moves it");
  });

  it("needs no change when the portal itself moves or clears the overdue one: MAYA leaves the other alone and pays", () => {
    for (const after of ["pm_new", null]) {
      const r = { ...group, overdue: { before: "pm_fail", after } };
      const v = readProof(r);
      expect(mayaPlanFor(r)?.ownCard).toBe("own_card");
      expect(v.changeNeeded).toBe(false);
      expect(v.maya).toContain("pays its open invoice with the new card at once");
      expect(v.maya).toContain("leaves the subscription on its own card alone");
    }
  });

  it("notes when the portal paid the overdue invoice itself", () => {
    const v = readProof({ ...group, overdue: { before: "pm_fail", after: null }, overdueInvoice: "paid" });
    expect(v.finding).toContain("paid the overdue invoice itself");
    expect(v.maya).toContain("finds no open invoice to pay");
  });

  it("shows the one-property case: the portal keeps the failing card and MAYA moves it and pays", () => {
    const v = readProof(single);
    expect(mayaPlanFor(single)).toEqual({ overdue: "move", ownCard: null, ambiguous: false });
    expect(v.changeNeeded).toBe(false);
    expect(v.maya).toBe("MAYA moves the overdue subscription to the new card and pays its open invoice with the new card at once.");
    expect(v.action).toContain("gap A35 closes");
  });

  it("needs no change for one property the portal moved itself", () => {
    const v = readProof({ ...single, overdue: { before: "pm_fail", after: "pm_new" } });
    expect(v.changeNeeded).toBe(false);
    expect(v.maya).toContain("is on the new card already");
  });

  it("flags a card that is neither the old one nor the new default", () => {
    expect(readProof({ ...group, overdue: { before: "pm_fail", after: "pm_odd" } }).changeNeeded).toBe(true);
  });
});
