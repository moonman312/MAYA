/**
 * Removing a Mews property's keys is done at the owner's request, so the
 * outage it starts is marked as dealt with in the same write: the scheduled
 * "connection down" email (sendDueOutageNotices) must not follow an hour later.
 */
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { deleteMewsCredentials } from "./pms";

describe("deleteMewsCredentials", () => {
  it("disconnects and marks the outage as already dealt with", async () => {
    const updates: Record<string, unknown>[] = [];
    const rpcs: string[] = [];
    const admin = {
      rpc: async (name: string) => {
        rpcs.push(name);
        return { data: null, error: null };
      },
      from: (table: string) => {
        expect(table).toBe("pms_connections");
        const chain = {
          update(payload: Record<string, unknown>) {
            updates.push(payload);
            return chain;
          },
          eq: () => chain,
          then: <T>(resolve: (v: { error: null }) => T) => Promise.resolve({ error: null }).then(resolve),
        };
        return chain;
      },
    } as unknown as SupabaseClient;

    await deleteMewsCredentials(admin, "hotel-1");

    expect(rpcs).toEqual(["pms_secret_delete", "platform_log_event"]);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ status: "disconnected", outage_notice_at: expect.any(String) });
    expect(updates[0].outage_notice_at).toBe(updates[0].updated_at);
  });
});
