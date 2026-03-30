import { beforeEach, describe, expect, it } from "vitest";
import * as store from "./rules-store";

describe("rules-store (in-memory mode)", () => {
  beforeEach(() => {
    store._resetForTesting();
  });

  /* ── listRules ──────────────────────────────────────────────── */

  it("returns seed rules on first call", async () => {
    const rules = await store.listRules();
    expect(rules.length).toBe(4);
    expect(rules[0].rule_name).toBe("High Occupancy Surge");
    expect(rules[3].rule_name).toBe("Early Bird Discount");
  });

  it("seed rules have correct structure", async () => {
    const rules = await store.listRules();
    for (const r of rules) {
      expect(r).toHaveProperty("id");
      expect(r).toHaveProperty("rule_name");
      expect(r).toHaveProperty("conditions");
      expect(r).toHaveProperty("action");
      expect(r).toHaveProperty("room_types");
      expect(typeof r.enabled).toBe("boolean");
    }
  });

  /* ── createRule ─────────────────────────────────────────────── */

  it("creates a new rule and appends it", async () => {
    const rule = await store.createRule({
      rule_name: "New Rule",
      conditions: { occupancy_percentage: ">90" },
      action: { adjust_rate_percent: 20 },
      room_types: ["Suite"],
    });
    expect(rule.rule_name).toBe("New Rule");
    expect(rule.enabled).toBe(true);
    expect(rule.room_types).toEqual(["Suite"]);

    const all = await store.listRules();
    expect(all.length).toBe(5);
    expect(all[4].id).toBe(rule.id);
  });

  it("assigns incrementing ids", async () => {
    const r1 = await store.createRule({
      rule_name: "A",
      conditions: {},
      action: { adjust_rate_dollars: 5 },
      room_types: [],
    });
    const r2 = await store.createRule({
      rule_name: "B",
      conditions: {},
      action: { adjust_rate_dollars: 10 },
      room_types: [],
    });
    expect(Number(r2.id)).toBeGreaterThan(Number(r1.id));
  });

  /* ── toggleRule ─────────────────────────────────────────────── */

  it("toggles an enabled rule to disabled", async () => {
    const rules = await store.listRules();
    const target = rules[0]; // High Occupancy Surge (enabled: true)
    expect(target.enabled).toBe(true);

    const ok = await store.toggleRule(target.id);
    expect(ok).toBe(true);

    const updated = await store.listRules();
    expect(updated.find((r) => r.id === target.id)?.enabled).toBe(false);
  });

  it("toggles a disabled rule to enabled", async () => {
    const rules = await store.listRules();
    const target = rules[3]; // Early Bird Discount (enabled: false)
    expect(target.enabled).toBe(false);

    await store.toggleRule(target.id);

    const updated = await store.listRules();
    expect(updated.find((r) => r.id === target.id)?.enabled).toBe(true);
  });

  it("double toggle restores original state", async () => {
    const rules = await store.listRules();
    const target = rules[0];
    const original = target.enabled;

    await store.toggleRule(target.id);
    await store.toggleRule(target.id);

    const updated = await store.listRules();
    expect(updated.find((r) => r.id === target.id)?.enabled).toBe(original);
  });

  it("returns false for non-existent rule", async () => {
    const ok = await store.toggleRule("99999");
    expect(ok).toBe(false);
  });

  /* ── deleteRule ─────────────────────────────────────────────── */

  it("deletes a rule by id", async () => {
    const rules = await store.listRules();
    const target = rules[1];
    const ok = await store.deleteRule(target.id);
    expect(ok).toBe(true);

    const remaining = await store.listRules();
    expect(remaining.length).toBe(3);
    expect(remaining.find((r) => r.id === target.id)).toBeUndefined();
  });

  it("returns false when deleting non-existent rule", async () => {
    const ok = await store.deleteRule("99999");
    expect(ok).toBe(false);
  });

  it("delete does not affect other rules", async () => {
    // listRules returns the array by reference, so capture count before mutation
    const initialCount = (await store.listRules()).length;
    expect(initialCount).toBe(4);

    const targetId = "2"; // Last-Minute Premium
    const ok = await store.deleteRule(targetId);
    expect(ok).toBe(true);

    const remaining = await store.listRules();
    expect(remaining.length).toBe(3);
    expect(remaining.find((r) => r.id === targetId)).toBeUndefined();
    // Other rules are still present
    expect(remaining.find((r) => r.id === "1")).toBeDefined();
    expect(remaining.find((r) => r.id === "3")).toBeDefined();
    expect(remaining.find((r) => r.id === "4")).toBeDefined();
  });

  /* ── Full CRUD sequence ─────────────────────────────────────── */

  it("handles create → toggle → delete lifecycle", async () => {
    const rule = await store.createRule({
      rule_name: "Lifecycle Rule",
      conditions: { occupancy_percentage: ">50" },
      action: { adjust_rate_percent: 5 },
      room_types: [],
    });
    expect(rule.enabled).toBe(true);

    await store.toggleRule(rule.id);
    let list = await store.listRules();
    expect(list.find((r) => r.id === rule.id)?.enabled).toBe(false);

    await store.deleteRule(rule.id);
    list = await store.listRules();
    expect(list.find((r) => r.id === rule.id)).toBeUndefined();
  });
});
