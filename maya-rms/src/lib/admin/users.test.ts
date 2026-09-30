/**
 * The role picker's call: one staff role or none, through
 * platform_set_staff_role under the admin's own session, and the database's
 * refusals passed on in its own words.
 */
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { setStaffRole } from "./users";

function client(result: { data: unknown; error: { message: string } | null }, calls: unknown[] = []): SupabaseClient {
  return { rpc: async (name: string, args: unknown) => (calls.push([name, args]), result) } as unknown as SupabaseClient;
}

describe("setStaffRole", () => {
  it("sends the one role and reads back what changed", async () => {
    const calls: unknown[] = [];
    const out = await setStaffRole(client({ data: { role: "sales", previous: ["developer"], changed: true }, error: null }, calls), "u1", "sales");
    expect(calls).toEqual([["platform_set_staff_role", { p_user_id: "u1", p_role: "sales" }]]);
    expect(out).toEqual({ role: "sales", previous: ["developer"], changed: true });
  });

  it("passes on a refusal as it is", async () => {
    const message = "MAYA needs at least one platform admin. Make someone else a platform admin first.";
    await expect(setStaffRole(client({ data: null, error: { message } }), "u1", "none")).rejects.toThrow(message);
  });
});
