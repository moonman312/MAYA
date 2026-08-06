/**
 * The two defaults here are more dangerous than the check itself.
 *
 * A hotel with no subscription row must keep working — the sandbox property,
 * anything an admin created by hand, and every install with no Stripe keys have
 * never had one. And a failed lookup must let everybody through, because
 * stopping the entire customer base on a transient database error is a far worse
 * outage than briefly serving one hotel that stopped paying.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isEntitledStatus, isHotelEntitled, splitByEntitlement } from "./entitlement";

type Row = { hotel_id: string; status: string };

function fakeAdmin(rows: Row[], error?: string) {
  const seen: { table?: string; ids?: string[] } = {};
  const admin = {
    from(table: string) {
      seen.table = table;
      return {
        select: () => ({
          in: (_col: string, ids: string[]) => {
            seen.ids = ids;
            return Promise.resolve(
              error
                ? { data: null, error: { message: error } }
                : { data: rows.filter((r) => ids.includes(r.hotel_id)), error: null },
            );
          },
        }),
      };
    },
  };
  return { admin: admin as unknown as SupabaseClient, seen };
}

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("isEntitledStatus", () => {
  it("keeps working through the dunning window", () => {
    // Stripe retries a failed card for about two weeks. Cutting pricing off on
    // the first failure would punish an expired card harder than a cancellation.
    expect(isEntitledStatus("trialing")).toBe(true);
    expect(isEntitledStatus("active")).toBe(true);
    expect(isEntitledStatus("past_due")).toBe(true);
  });

  it("stops once the retries have run out", () => {
    expect(isEntitledStatus("unpaid")).toBe(false);
    expect(isEntitledStatus("canceled")).toBe(false);
    expect(isEntitledStatus("incomplete")).toBe(false);
    expect(isEntitledStatus("incomplete_expired")).toBe(false);
    expect(isEntitledStatus("paused")).toBe(false);
  });

  it("does not invent an answer for a status it has never seen", () => {
    expect(isEntitledStatus(null)).toBe(false);
    expect(isEntitledStatus(undefined)).toBe(false);
    expect(isEntitledStatus("something_stripe_added_later")).toBe(false);
  });
});

describe("splitByEntitlement", () => {
  it("lets a hotel with no subscription row through", async () => {
    // The sandbox hotel and every admin-created property live here. Blocking
    // them would take down testing and every deployment that never sells.
    const { admin } = fakeAdmin([]);
    const split = await splitByEntitlement(admin, ["sandbox"]);
    expect(split.allowed).toEqual(["sandbox"]);
    expect(split.blocked).toEqual([]);
  });

  it("blocks only the lapsed ones and says which status stopped them", async () => {
    const { admin } = fakeAdmin([
      { hotel_id: "paying", status: "active" },
      { hotel_id: "trial", status: "trialing" },
      { hotel_id: "late", status: "past_due" },
      { hotel_id: "gone", status: "canceled" },
      { hotel_id: "stopped", status: "unpaid" },
    ]);
    const split = await splitByEntitlement(admin, ["paying", "trial", "late", "gone", "stopped", "never-paid"]);
    expect(split.allowed).toEqual(["paying", "trial", "late", "never-paid"]);
    expect(split.blocked).toEqual([
      { hotelId: "gone", status: "canceled" },
      { hotelId: "stopped", status: "unpaid" },
    ]);
  });

  it("fails open when the lookup itself breaks", async () => {
    const { admin } = fakeAdmin([], "connection reset");
    const split = await splitByEntitlement(admin, ["a", "b"]);
    expect(split.allowed).toEqual(["a", "b"]);
    expect(split.blocked).toEqual([]);
    // Silent would be the real bug: nothing else would ever reveal that the
    // gate stopped gating.
    expect(errorSpy).toHaveBeenCalled();
  });

  it("does not query at all for an empty batch", async () => {
    const { admin, seen } = fakeAdmin([]);
    expect(await splitByEntitlement(admin, [])).toEqual({ allowed: [], blocked: [] });
    expect(seen.table).toBeUndefined();
  });

  it("preserves the caller's hotel order", async () => {
    const { admin } = fakeAdmin([
      { hotel_id: "a", status: "active" },
      { hotel_id: "c", status: "active" },
    ]);
    expect((await splitByEntitlement(admin, ["c", "b", "a"])).allowed).toEqual(["c", "b", "a"]);
  });
});

describe("isHotelEntitled", () => {
  it("answers for one hotel", async () => {
    const { admin } = fakeAdmin([{ hotel_id: "h", status: "canceled" }]);
    expect(await isHotelEntitled(admin, "h")).toBe(false);
  });

  it("says yes when billing was never in play", async () => {
    const { admin } = fakeAdmin([]);
    expect(await isHotelEntitled(admin, "h")).toBe(true);
  });
});
