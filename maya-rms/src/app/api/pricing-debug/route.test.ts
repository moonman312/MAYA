import { describe, expect, it, vi } from "vitest";
import { fakeSupabase } from "@/lib/engine/fake-supabase.test";

const state = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/server", () => ({ createClient: () => state.client }));

const { GET } = await import("./route");

describe("GET /api/pricing-debug", () => {
  it("returns the cell's ladder states through the hotel's own rules", async () => {
    const fake = fakeSupabase({
      pricing_rules: [{ id: "r1", hotel_id: "h1" }, { id: "r2", hotel_id: "h1" }, { id: "x1", hotel_id: "h2" }],
      ladder_rule_state: [
        { rule_id: "r1", stay_date: "2026-10-01", room_type_id: "rt1", is_active: true },
        { rule_id: "r2", stay_date: "2026-10-01", room_type_id: "rt1", is_active: false },
        { rule_id: "r1", stay_date: "2026-10-02", room_type_id: "rt1", is_active: true },
        { rule_id: "x1", stay_date: "2026-10-01", room_type_id: "rt1", is_active: true },
      ],
      evaluation_run_log: [
        { hotel_id: "h1", evaluated_at: "2026-09-17T10:00:00Z" },
        { hotel_id: "h1", evaluated_at: "2026-09-17T10:05:00Z" },
        { hotel_id: "h2", evaluated_at: "2026-09-17T10:10:00Z" },
      ],
    });
    state.client = Object.assign(fake.client, { auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) } });
    const res = await GET(new Request("http://localhost/api/pricing-debug?hotel_id=h1&stay_date=2026-10-01&room_type_id=rt1") as never);
    const body = await res.json();
    expect(JSON.stringify(body)).toContain('"rule_id":"r1"');
    expect(JSON.stringify(body)).toContain('"rule_id":"r2"');
    expect(JSON.stringify(body)).not.toContain('"rule_id":"x1"');
    const stateRead = fake.calls.find((c) => c.table === "ladder_rule_state")!;
    expect(body.last_run_at).toBe("2026-09-17T10:05:00Z");
    expect(stateRead.filters.find((f) => f.col === "rule_id")?.value).toEqual(["r1", "r2"]);
  });
});
