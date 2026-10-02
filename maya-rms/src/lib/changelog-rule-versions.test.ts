/**
 * The change log's read of the rule version behind each fire on rows written
 * before the audit kept it (A46).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { firesWithoutVersion, pickupVersionsFor } from "./changelog-rule-versions";

const rows = [
  {
    details: {
      active_pickup_effects: [
        { event_id: "e1", rule_id: "r1", delta: "+10%" },
        // The row says which version made it: nothing to read.
        { event_id: "e2", rule_id: "r1", delta: "+10%", rule_version: 3 },
        // The row kept the rule itself.
        { event_id: "e3", rule_id: "r2", delta: "+5%" },
      ],
      rule_snapshots: { r2: { name: "Late surge", version: 2, condition: {} } },
    },
  },
  { details: { active_pickup_effects: [{ event_id: "e1", rule_id: "r1", delta: "+10%" }, { event_id: "e4", rule_id: "r3", delta: "-$5.00" }] } },
  { details: null },
  {},
];

function fakeClient(answer: (ids: string[]) => { data: unknown[] | null; error: { message: string } | null }) {
  const calls: { table: string; hotel: unknown; ids: string[] }[] = [];
  const client = {
    from(table: string) {
      const call = { table, hotel: null as unknown, ids: [] as string[] };
      const q = {
        select: () => q,
        eq: (_col: string, v: unknown) => {
          call.hotel = v;
          return q;
        },
        in: (_col: string, ids: string[]) => {
          call.ids = ids;
          calls.push(call);
          return Promise.resolve(answer(ids));
        },
      };
      return q;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, calls };
}

afterEach(() => vi.restoreAllMocks());

describe("firesWithoutVersion", () => {
  it("names each fire once whose row gives neither its version nor its rule", () => {
    expect(firesWithoutVersion(rows)).toEqual(["e1", "e4"]);
  });
});

describe("pickupVersionsFor", () => {
  it("reads those fires' versions from pickup_event, for this hotel only", async () => {
    const { client, calls } = fakeClient((ids) => ({ data: ids.map((id) => ({ id, rule_version: id === "e1" ? 1 : "2" })), error: null }));
    const versions = await pickupVersionsFor(client, "hotel-1", rows);
    expect(calls).toEqual([{ table: "pickup_event", hotel: "hotel-1", ids: ["e1", "e4"] }]);
    expect(versions).toEqual(new Map([["e1", 1], ["e4", 2]]));
  });

  it("asks nothing when every row says", async () => {
    const { client, calls } = fakeClient(() => ({ data: [], error: null }));
    expect(await pickupVersionsFor(client, "hotel-1", [rows[2], rows[3]])).toEqual(new Map());
    expect(calls).toEqual([]);
  });

  it("reads in chunks, and a failed read logs and leaves the rest unknown", async () => {
    const many = [{ details: { active_pickup_effects: Array.from({ length: 450 }, (_, i) => ({ event_id: `e${i}`, rule_id: "r1", delta: "+1%" })) } }];
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    let n = 0;
    const { client, calls } = fakeClient((ids) =>
      ++n === 2 ? { data: null, error: { message: "boom" } } : { data: ids.map((id) => ({ id, rule_version: 1 })), error: null },
    );
    const versions = await pickupVersionsFor(client, "hotel-1", many);
    expect(calls.map((c) => c.ids.length)).toEqual([200, 200]);
    expect(versions.size).toBe(200);
    expect(String(err.mock.calls[0][0])).toContain("pickup_versions");
  });
});
