/**
 * Cloudbeds certification tests "connecting and disconnecting apps" across
 * multiple properties. A user revoking access in the Cloudbeds Marketplace
 * does not expire the access token, so every data call starts returning 401
 * while the token-refresh path — the only place MAYA used to notice — never
 * runs. The result was a PMS tab showing a green "Connected" pill next to a
 * red health badge and a log full of 401s.
 */
import { describe, expect, it, vi } from "vitest";
import {
  isAuthRevocation,
  markConnectionDisconnected,
} from "../../../supabase/functions/_shared/pms/connection-health";
import type { SupabaseClient } from "@supabase/supabase-js";

function stub(updateError?: string) {
  const updates: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const supabase = {
    from() {
      const q: Record<string, unknown> = {
        update(payload: Record<string, unknown>) {
          updates.push(payload);
          return q;
        },
      };
      q.eq = () => q;
      (q as { then: unknown }).then = (res: (v: { error: { message: string } | null }) => unknown) =>
        res({ error: updateError ? { message: updateError } : null });
      return q;
    },
    rpc(name: string, args: Record<string, unknown>) {
      events.push({ name, ...args });
      return Promise.resolve({ data: null, error: null });
    },
  } as unknown as SupabaseClient;
  return { supabase, updates, events };
}

describe("isAuthRevocation", () => {
  it("treats 401 and 403 as a withdrawn grant", () => {
    expect(isAuthRevocation(401)).toBe(true);
    expect(isAuthRevocation(403)).toBe(true);
  });

  it("leaves outages alone — a 500 or a rate limit is not a disconnect", () => {
    for (const s of [429, 500, 502, 503, 400, null, undefined]) {
      expect(isAuthRevocation(s)).toBe(false);
    }
  });
});

describe("markConnectionDisconnected", () => {
  it("flips the row to disconnected and records the event", async () => {
    const { supabase, updates, events } = stub();
    await markConnectionDisconnected(supabase, "h1", "cloudbeds", "401 from getReservations");

    expect(updates[0]).toMatchObject({ status: "disconnected" });
    expect(events[0]).toMatchObject({
      name: "platform_log_event",
      p_event_type: "pms.disconnected",
      p_hotel_id: "h1",
    });
  });

  it("swallows its own write failure rather than masking the original error", async () => {
    // This runs inside failure handling; a bookkeeping error must not become
    // the error the caller reports.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { supabase } = stub("statement timeout");
    await expect(
      markConnectionDisconnected(supabase, "h1", "cloudbeds", "401"),
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
