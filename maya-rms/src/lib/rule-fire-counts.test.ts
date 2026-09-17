import { describe, expect, it, vi } from "vitest";
import { FakeRpcError, fakeSupabase, missingFunction, type FakeRow } from "./engine/fake-supabase.test";
import { ruleFireCounts } from "./rule-fire-counts";

function history() {
  const ladder: FakeRow[] = [];
  const pickup: FakeRow[] = [];
  const rules = ["r1", "r2", "r3"].map((id) => ({ id, hotel_id: "h1" }));
  for (let i = 0; i < 4800; i++) {
    ladder.push({ id: `l${i}`, hotel_id: i % 50 === 0 ? "h2" : "h1", rule_id: rules[i % 3].id, transition: i % 4 === 0 ? "deactivate" : "activate" });
  }
  for (let i = 0; i < 700; i++) pickup.push({ id: `p${i}`, hotel_id: "h1", rule_id: i % 2 ? "r1" : "r3" });
  return { pricing_rules: rules, ladder_transition_event: ladder, pickup_event: pickup };
}

function truth(seed: ReturnType<typeof history>) {
  const counts: Record<string, number> = {};
  for (const e of seed.ladder_transition_event) {
    if (e.hotel_id === "h1" && e.transition === "activate") counts[String(e.rule_id)] = (counts[String(e.rule_id)] ?? 0) + 1;
  }
  for (const e of seed.pickup_event) counts[String(e.rule_id)] = (counts[String(e.rule_id)] ?? 0) + 1;
  return counts;
}

describe("ruleFireCounts", () => {
  it.each([
    ["migrated", {}],
    ["before the migration", { rpc: (fn: string) => new FakeRpcError(missingFunction(fn)) }],
  ])("counts every fire past the 1,000-row cap (%s)", async (_l, opts) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const seed = history();
    const { client } = fakeSupabase(seed, { maxRows: 1000, ...opts });
    expect(await ruleFireCounts(client, "h1")).toEqual(truth(seed));
  });

  it("on a small history gives what counting the rows in the app gave", async () => {
    const seed = { pricing_rules: [{ id: "r1", hotel_id: "h1" }], ladder_transition_event: [{ hotel_id: "h1", rule_id: "r1", transition: "activate" }], pickup_event: [{ hotel_id: "h1", rule_id: "r1" }, { hotel_id: "h1", rule_id: "r1" }] };
    const { client } = fakeSupabase(seed);
    expect(await ruleFireCounts(client, "h1")).toEqual({ r1: 3 });
  });
});
