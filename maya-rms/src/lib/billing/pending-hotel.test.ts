/**
 * The queue of Marketplace properties still waiting to be paid for.
 *
 * A group grant parks several hotels under one owner and a subscription is per
 * hotel, so payment goes round one property at a time. What matters here is the
 * boundary: only a hotel a REDEEMED claim points at is in the queue — Flow B's
 * placeholder has exactly the same shape and belongs to the PMS connect — and
 * only until a live subscription lands on it. The order matters too, because
 * checkout, the subscribe page and the return route each read this separately
 * and must all name the same "next".
 */
import { describe, expect, it } from "vitest";

type Row = Record<string, unknown>;

/** Just the read shapes pending-hotel.ts uses, with order() honoured. */
function fakeAdmin(seed: Record<string, Row[]>, opts: { noGroupKey?: boolean } = {}) {
  const tables = new Map(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  const orders: string[] = [];
  const builder = (table: string) => {
    const filters: ((r: Row) => boolean)[] = [];
    const sortBy: string[] = [];
    let cap: number | null = null;
    let columns = "";
    const api = {
      select(cols = "") {
        columns = cols;
        return api;
      },
      eq(col: string, val: unknown) {
        filters.push((r) => r[col] === val);
        return api;
      },
      in(col: string, vals: unknown[]) {
        filters.push((r) => vals.includes(r[col]));
        return api;
      },
      not(col: string) {
        filters.push((r) => r[col] != null);
        return api;
      },
      order(col: string) {
        sortBy.push(col);
        orders.push(`${table}.${col}`);
        return api;
      },
      limit(n: number) {
        cap = n;
        return api;
      },
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      then(resolve: (v: unknown) => void) {
        if (opts.noGroupKey && table === "pms_marketplace_claims" && columns.includes("group_key")) {
          return Promise.resolve({
            data: null,
            error: { code: "42703", message: "column pms_marketplace_claims.group_key does not exist" },
          }).then(resolve);
        }
        return Promise.resolve({ data: run(), error: null }).then(resolve);
      },
    };
    function run(): Row[] {
      let rows = (tables.get(table) ?? []).filter((r) => filters.every((f) => f(r)));
      if (sortBy.length) {
        rows = [...rows].sort((a, b) => {
          for (const col of sortBy) {
            const c = String(a[col] ?? "").localeCompare(String(b[col] ?? ""));
            if (c !== 0) return c;
          }
          return 0;
        });
      }
      return cap == null ? rows : rows.slice(0, cap);
    }
    return api;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: { from: builder } as any, orders };
}

const { findPendingHotelForUser, listUnpaidMarketplaceHotels } = await import("./pending-hotel");

const USER = "user-1";
const member = (hotelId: string) => ({ hotel_id: hotelId, user_id: USER, status: "active" });
const parked = (id: string, name: string, createdAt: string) => ({
  id,
  name,
  is_active: false,
  setup_pending_at: "2026-09-10T14:08:00Z",
  created_at: createdAt,
});
const claim = (hotelId: string, propertyName: string | null, groupKey: string | null = "grp-1") => ({
  token: `tok-${hotelId}`,
  hotel_id: hotelId,
  pms_type: "cloudbeds",
  property_name: propertyName,
  claimed_by: USER,
  claimed_at: "2026-09-10T14:09:00Z",
  group_key: groupKey,
});

const withoutGroupKey = (row: Row) => {
  const copy = { ...row };
  delete copy.group_key;
  return copy;
};

describe("listUnpaidMarketplaceHotels", () => {
  it("answers nothing for an account with no memberships", async () => {
    const { client } = fakeAdmin({});
    await expect(listUnpaidMarketplaceHotels(client, USER)).resolves.toEqual([]);
  });

  it("lists a group's parked properties oldest first, with the claim's name and group", async () => {
    const { client } = fakeAdmin({
      hotel_memberships: [member("h-b"), member("h-a"), member("h-c")],
      hotels: [
        parked("h-c", "Cliff House", "2026-09-10T14:08:02Z"),
        parked("h-a", "Sea View Inn", "2026-09-10T14:08:00Z"),
        parked("h-b", "Bay Lodge", "2026-09-10T14:08:01Z"),
      ],
      pms_marketplace_claims: [claim("h-a", "Sea View Inn"), claim("h-b", null), claim("h-c", "Cliff House")],
    });
    const unpaid = await listUnpaidMarketplaceHotels(client, USER);
    expect(unpaid.map((u) => u.hotelId)).toEqual(["h-a", "h-b", "h-c"]);
    expect(unpaid[0]).toEqual({
      hotelId: "h-a",
      name: "Sea View Inn",
      propertyName: "Sea View Inn",
      pmsType: "cloudbeds",
      groupKey: "grp-1",
    });
    expect(unpaid[1].propertyName).toBeNull();
  });

  it("breaks a created_at tie on name", async () => {
    const same = "2026-09-10T14:08:00Z";
    const { client } = fakeAdmin({
      hotel_memberships: [member("h-1"), member("h-2")],
      hotels: [parked("h-1", "Zinnia", same), parked("h-2", "Aster", same)],
      pms_marketplace_claims: [claim("h-1", null), claim("h-2", null)],
    });
    const unpaid = await listUnpaidMarketplaceHotels(client, USER);
    expect(unpaid.map((u) => u.name)).toEqual(["Aster", "Zinnia"]);
  });

  it("drops a property once a live subscription lands on it, and keeps one whose subscription died", async () => {
    const { client } = fakeAdmin({
      hotel_memberships: [member("h-paid"), member("h-dead"), member("h-none")],
      hotels: [
        parked("h-paid", "Paid", "2026-09-10T14:08:00Z"),
        parked("h-dead", "Dead", "2026-09-10T14:08:01Z"),
        parked("h-none", "None", "2026-09-10T14:08:02Z"),
      ],
      pms_marketplace_claims: [claim("h-paid", null), claim("h-dead", null), claim("h-none", null)],
      hotel_subscriptions: [
        { hotel_id: "h-paid", status: "trialing" },
        // incomplete: they closed the card form. Still owed a checkout.
        { hotel_id: "h-dead", status: "incomplete" },
      ],
    });
    const unpaid = await listUnpaidMarketplaceHotels(client, USER);
    expect(unpaid.map((u) => u.hotelId)).toEqual(["h-dead", "h-none"]);
  });

  it("leaves Flow B's placeholder alone — same shape, no claim, and the PMS connect owns it", async () => {
    const { client } = fakeAdmin({
      hotel_memberships: [member("h-flow-b")],
      hotels: [parked("h-flow-b", "Pending setup 1a2b3c4d", "2026-09-10T14:08:00Z")],
    });
    await expect(listUnpaidMarketplaceHotels(client, USER)).resolves.toEqual([]);
  });

  it("ignores an unredeemed ticket — nobody owns that property yet", async () => {
    const { client } = fakeAdmin({
      hotel_memberships: [member("h-1")],
      hotels: [parked("h-1", "Sea View Inn", "2026-09-10T14:08:00Z")],
      pms_marketplace_claims: [{ ...claim("h-1", null), claimed_by: null, claimed_at: null }],
    });
    await expect(listUnpaidMarketplaceHotels(client, USER)).resolves.toEqual([]);
  });

  it("skips a property that has already gone live, and one whose membership lapsed", async () => {
    const { client } = fakeAdmin({
      hotel_memberships: [member("h-live"), { ...member("h-gone"), status: "revoked" }],
      hotels: [
        { ...parked("h-live", "Live", "2026-09-10T14:08:00Z"), is_active: true, setup_pending_at: null },
        parked("h-gone", "Gone", "2026-09-10T14:08:01Z"),
      ],
      pms_marketplace_claims: [claim("h-live", null), claim("h-gone", null)],
    });
    await expect(listUnpaidMarketplaceHotels(client, USER)).resolves.toEqual([]);
  });

  it("still answers when the group_key column has not been migrated yet", async () => {
    const { client } = fakeAdmin(
      {
        hotel_memberships: [member("h-1")],
        hotels: [parked("h-1", "Sea View Inn", "2026-09-10T14:08:00Z")],
        // No column, no value: the row a pre-migration table would return.
        pms_marketplace_claims: [withoutGroupKey(claim("h-1", "Sea View Inn"))],
      },
      { noGroupKey: true },
    );
    const unpaid = await listUnpaidMarketplaceHotels(client, USER);
    expect(unpaid).toHaveLength(1);
    expect(unpaid[0]).toMatchObject({ hotelId: "h-1", groupKey: null });
  });

  it("throws rather than answering 'nothing owed' when a read fails", async () => {
    const broken = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: async () => ({ data: null, error: { message: "permission denied" } }),
          }),
        }),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    await expect(listUnpaidMarketplaceHotels(broken, USER)).rejects.toThrow("permission denied");
  });
});

describe("findPendingHotelForUser", () => {
  it("names the oldest parked row when several are unpaid, whatever order the rows came back in", async () => {
    // A group grant parks several at once. ids[0] off an unordered read could
    // point checkout and the connect callback at different hotels.
    const { client, orders } = fakeAdmin({
      hotel_memberships: [member("h-new"), member("h-old")],
      hotels: [
        parked("h-new", "Newer", "2026-09-10T14:08:05Z"),
        parked("h-old", "Older", "2026-09-10T14:08:00Z"),
      ],
    });
    await expect(findPendingHotelForUser(client, USER)).resolves.toBe("h-old");
    expect(orders).toContain("hotels.created_at");
  });

  it("still prefers the row a payment attached to over the oldest", async () => {
    const { client } = fakeAdmin({
      hotel_memberships: [member("h-new"), member("h-old")],
      hotels: [
        parked("h-new", "Newer", "2026-09-10T14:08:05Z"),
        parked("h-old", "Older", "2026-09-10T14:08:00Z"),
      ],
      hotel_subscriptions: [{ hotel_id: "h-new", status: "active" }],
    });
    await expect(findPendingHotelForUser(client, USER)).resolves.toBe("h-new");
  });
});
