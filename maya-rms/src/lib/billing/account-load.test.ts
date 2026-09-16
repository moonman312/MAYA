/**
 * The shortfall countdown on the billing page has to agree with trueUpOne,
 * which waits for the full grace period after the notice about this shortfall.
 */
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("./room-count", async (importActual) => ({
  ...(await importActual<typeof import("./room-count")>()),
  measureRooms: async () => ({ excluded: [], allExcluded: false }),
}));
vi.mock("./stripe", () => ({ isStripeConfigured: () => false, stripeClient: () => null }));

import { loadAccountBilling, roomGraceDaysLeft } from "./account";

const NOW = new Date("2026-08-10T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const base = {
  hotel_id: "hotel-1",
  billed_rooms: 40,
  measured_rooms: 60,
  room_shortfall_since: daysAgo(10),
};

describe("roomGraceDaysLeft", () => {
  it("counts from the notice, not from the first measurement", () => {
    const left = roomGraceDaysLeft(
      { ...base, room_shortfall_notified_at: daysAgo(2), room_shortfall_notified_rooms: 60 },
      NOW,
    );
    expect(left).toBe(5);
  });

  it("is null when no notice went out", () => {
    expect(roomGraceDaysLeft({ ...base, room_shortfall_notified_at: null }, NOW)).toBeNull();
  });

  it("is null when the notice quoted a different count", () => {
    expect(
      roomGraceDaysLeft({ ...base, room_shortfall_notified_at: daysAgo(2), room_shortfall_notified_rooms: 25 }, NOW),
    ).toBeNull();
  });

  it("is null when the notice was about an earlier shortfall", () => {
    expect(
      roomGraceDaysLeft({ ...base, room_shortfall_notified_at: daysAgo(90), room_shortfall_notified_rooms: 60 }, NOW),
    ).toBeNull();
  });
});

describe("loadAccountBilling before the notice migration", () => {
  it("retries without the notice columns and shows no countdown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const selects: string[] = [];
    const supabase = {
      from: () => {
        let columns = "";
        const chain = {
          select: (c: string) => {
            columns = c;
            selects.push(c);
            return chain;
          },
          eq: () => chain,
          maybeSingle: async () =>
            columns.includes("room_shortfall_notified_at")
              ? { data: null, error: { code: "42703", message: "column does not exist" } }
              : { data: { ...base, status: "active", billing_interval: "month" }, error: null },
        };
        return chain;
      },
    } as unknown as SupabaseClient;

    const billing = await loadAccountBilling(supabase, "hotel-1");
    vi.useRealTimers();
    expect(selects).toHaveLength(2);
    expect(billing?.roomTruth.kind).toBe("short");
    expect(billing?.roomGraceDaysLeft).toBeNull();
  });
});
