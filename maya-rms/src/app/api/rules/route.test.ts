/**
 * The rules routes refuse a room type set that would leave a rule measuring
 * or changing nothing, before anything reaches the store.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const createRule = vi.fn(async (input: unknown) => ({ id: "r1", input }));
const updateRule = vi.fn(async () => true);

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/server", () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) } }),
}));
vi.mock("@/lib/hotel-context", () => ({ resolveAccessibleHotelId: async () => "h1" }));
vi.mock("@/lib/rules-store", () => ({
  createRule,
  listRules: vi.fn(),
  updateRule,
  deleteRule: vi.fn(),
}));

const { POST } = await import("@/app/api/rules/route");
const { PUT } = await import("@/app/api/rules/[id]/route");

const base = {
  rule_name: "Busy",
  conditions: {},
  condition: { occupancy_operator: "gt", occupancy_threshold: 0.8 },
  action: { adjust_rate_percent: 10 },
  room_types: ["King"],
};
const req = (body: unknown, method = "POST") =>
  new Request("https://maya-rms.com/api/rules", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const params = { params: Promise.resolve({ id: "r1" }) };

beforeEach(() => {
  createRule.mockClear();
  updateRule.mockClear();
});

describe("room type sets on the rules routes", () => {
  it.each([
    [{ signal_room_type_ids: [], affected_room_type_ids: ["rt1"] }, "Pick at least one room type to measure."],
    [{ signal_room_type_ids: ["rt1"], affected_room_type_ids: [] }, "Pick at least one room type to change."],
    [{ signal_room_type_ids: "rt1", affected_room_type_ids: ["rt1"] }, "Invalid room types."],
    [{ signal_room_type_ids: [7], affected_room_type_ids: ["rt1"] }, "Invalid room types."],
  ])("POST refuses %j", async (sets, message) => {
    const res = await POST(req({ ...base, ...sets }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(message);
    expect(createRule).not.toHaveBeenCalled();
  });

  it("POST passes both sets through", async () => {
    const res = await POST(req({ ...base, signal_room_type_ids: ["rt1"], affected_room_type_ids: ["rt2"] }));
    expect(res.status).toBe(201);
    expect(createRule.mock.calls[0][0]).toMatchObject({ signal_room_type_ids: ["rt1"], affected_room_type_ids: ["rt2"] });
  });

  it("PUT refuses an empty set and passes a good one", async () => {
    const bad = await PUT(req({ affected_room_type_ids: [] }, "PUT"), params);
    expect(bad.status).toBe(400);
    expect(updateRule).not.toHaveBeenCalled();
    const good = await PUT(req({ signal_room_type_ids: ["rt1"] }, "PUT"), params);
    expect(good.status).toBe(200);
    expect(updateRule).toHaveBeenCalledTimes(1);
  });
});
