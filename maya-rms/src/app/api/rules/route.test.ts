/**
 * The rules routes refuse a room type set that would leave a rule measuring
 * or changing nothing, and a rule with both a percent and a fixed amount,
 * before anything reaches the store.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const createRule = vi.fn(async (input: unknown) => ({ id: "r1", input }));
const updateRule = vi.fn(async () => true);
const hasHotelRank = vi.fn(async () => true);
/** The rule the PUT route reads back when a save changed nothing. */
let ruleRow: { hotel_id: string } | null = { hotel_id: "h1" };

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: ruleRow, error: null }) }) }) }),
  }),
}));
vi.mock("@/lib/require-supabase-hotel", () => ({ hasHotelRank }));
vi.mock("@/lib/hotel-context", () => ({ resolveAccessibleHotelId: async () => "h1" }));
vi.mock("@/lib/rules-store", () => ({
  createRule,
  listRules: vi.fn(),
  updateRule,
  deleteRule: vi.fn(),
}));

const { POST } = await import("@/app/api/rules/route");
const { RoomTypeSetError, RuleAmountError } = await import("@/lib/rule-form");
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

  it("POST passes a pickup count rule's chosen wait through to the store", async () => {
    const condition = { pickup_operator: "gt", pickup_threshold: 5, pickup_window_days: 7, pickup_metric: "room_nights", pickup_cooldown_days: 2 };
    const res = await POST(req({ ...base, condition }));
    expect(res.status).toBe(201);
    expect(createRule.mock.calls[0][0]).toMatchObject({ condition });
  });

  it("POST passes both sets through", async () => {
    const res = await POST(req({ ...base, signal_room_type_ids: ["rt1"], affected_room_type_ids: ["rt2"] }));
    expect(res.status).toBe(201);
    expect(createRule.mock.calls[0][0]).toMatchObject({ signal_room_type_ids: ["rt1"], affected_room_type_ids: ["rt2"] });
  });

  it("answers 400, not a server error or not found, when the store refuses another hotel's room types", async () => {
    createRule.mockRejectedValueOnce(new RoomTypeSetError("measure"));
    const created = await POST(req({ ...base, signal_room_type_ids: ["elsewhere"], affected_room_type_ids: ["rt1"] }));
    expect(created.status).toBe(400);
    expect((await created.json()).error).toBe("Pick at least one room type to measure.");

    updateRule.mockRejectedValueOnce(new RoomTypeSetError("change"));
    const updated = await PUT(req({ affected_room_type_ids: ["elsewhere"] }, "PUT"), params);
    expect(updated.status).toBe(400);
    expect((await updated.json()).error).toBe("Pick at least one room type to change.");

    // Anything else is still a server error.
    createRule.mockRejectedValueOnce(new Error("boom"));
    expect((await POST(req(base))).status).toBe(500);
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

describe("the undo box on the rules routes", () => {
  it("POST creates a rule ticked unless the request unticks it", async () => {
    expect((await POST(req(base))).status).toBe(201);
    expect(createRule.mock.calls[0][0]).toMatchObject({ undo_on_cancellation: true });
    expect((await POST(req({ ...base, undo_on_cancellation: true }))).status).toBe(201);
    expect(createRule.mock.calls[1][0]).toMatchObject({ undo_on_cancellation: true });
    expect((await POST(req({ ...base, undo_on_cancellation: false }))).status).toBe(201);
    expect(createRule.mock.calls[2][0]).toMatchObject({ undo_on_cancellation: false });
  });

  it.each([["no"], [0], [null], [{}]])("POST and PUT refuse %j rather than guess", async (value) => {
    const created = await POST(req({ ...base, undo_on_cancellation: value }));
    expect(created.status).toBe(400);
    expect((await created.json()).error).toBe("Undo on cancellations must be true or false.");
    expect(createRule).not.toHaveBeenCalled();
    const updated = await PUT(req({ undo_on_cancellation: value }, "PUT"), params);
    expect(updated.status).toBe(400);
    expect(updateRule).not.toHaveBeenCalled();
  });

  it("PUT passes the box alone through to the store", async () => {
    const res = await PUT(req({ undo_on_cancellation: false }, "PUT"), params);
    expect(res.status).toBe(200);
    expect(updateRule.mock.calls[0]).toEqual(["r1", { undo_on_cancellation: false }, expect.anything()]);
  });

  it("PUT says why when the save changed nothing for someone who can't manage the hotel, and 404 otherwise", async () => {
    updateRule.mockResolvedValueOnce(false);
    hasHotelRank.mockResolvedValueOnce(false);
    const refused = await PUT(req({ undo_on_cancellation: false }, "PUT"), params);
    expect(refused.status).toBe(403);
    expect((await refused.json()).error).toBe("Only a Revenue Manager or above can change this.");
    expect(hasHotelRank).toHaveBeenLastCalledWith(expect.anything(), "h1", "revenue_manager");
    updateRule.mockResolvedValueOnce(false);
    expect((await PUT(req({ undo_on_cancellation: false }, "PUT"), params)).status).toBe(404);
    ruleRow = null;
    updateRule.mockResolvedValueOnce(false);
    expect((await PUT(req({ undo_on_cancellation: false }, "PUT"), params)).status).toBe(404);
    ruleRow = { hotel_id: "h1" };
  });
});

describe("one amount per rule on the rules routes", () => {
  const both = { adjust_rate_percent: 10, adjust_rate_dollars: 5 };

  it("POST refuses a percent and a fixed amount together with a 400 that says so", async () => {
    const res = await POST(req({ ...base, action: both }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Use a percent or a fixed amount, not both.");
    expect(createRule).not.toHaveBeenCalled();
  });

  it("PUT refuses the same, and passes one amount through", async () => {
    const refused = await PUT(req({ action: both }, "PUT"), params);
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toBe("Use a percent or a fixed amount, not both.");
    expect(updateRule).not.toHaveBeenCalled();
    expect((await PUT(req({ action: { adjust_rate_dollars: -15 } }, "PUT"), params)).status).toBe(200);
  });

  it("POST saves a percent alone or a fixed amount alone", async () => {
    expect((await POST(req({ ...base, action: { adjust_rate_percent: 10 } }))).status).toBe(201);
    expect((await POST(req({ ...base, action: { adjust_rate_dollars: 15 } }))).status).toBe(201);
    expect(createRule.mock.calls.map((c) => (c[0] as { action: unknown }).action)).toEqual([
      { adjust_rate_percent: 10 },
      { adjust_rate_dollars: 15 },
    ]);
  });

  it("answers 400 when the store refuses both", async () => {
    createRule.mockRejectedValueOnce(new RuleAmountError());
    const res = await POST(req(base));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Use a percent or a fixed amount, not both.");
  });
});
