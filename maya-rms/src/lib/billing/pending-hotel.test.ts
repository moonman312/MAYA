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
import { describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

/** Just the read shapes pending-hotel.ts uses, with order() honoured. */
function fakeAdmin(
  seed: Record<string, Row[]>,
  opts: { noGroupKey?: boolean; noDeferredColumn?: boolean } = {},
) {
  const tables = new Map(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  const orders: string[] = [];
  const builder = (table: string) => {
    const filters: ((r: Row) => boolean)[] = [];
    const filterCols: string[] = [];
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
      is(col: string) {
        filterCols.push(col);
        filters.push((r) => r[col] == null);
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
        if (
          opts.noDeferredColumn &&
          table === "hotels" &&
          (columns.includes("setup_deferred_at") || filterCols.includes("setup_deferred_at"))
        ) {
          return Promise.resolve({
            data: null,
            error: { code: "42703", message: "column hotels.setup_deferred_at does not exist" },
          }).then(resolve);
        }
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

const { findPendingHotelForUser, listDeferredMarketplaceHotels, listUnpaidMarketplaceHotels } =
  await import("./pending-hotel");

const USER = "user-1";
const member = (hotelId: string) => ({ hotel_id: hotelId, user_id: USER, status: "active" });
const parked = (id: string, name: string, createdAt: string) => ({
  id,
  name,
  is_active: false,
  setup_pending_at: "2026-09-10T14:08:00Z",
  setup_deferred_at: null,
  created_at: createdAt,
});
const DEFERRED_AT = "2026-09-16T09:00:00Z";
const deferred = (id: string, name: string, createdAt: string) => ({
  ...parked(id, name, createdAt),
  setup_deferred_at: DEFERRED_AT,
  setup_deferred_by: USER,
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

  it("leaves out a property the owner said 'not now' to, and keeps counting the rest", async () => {
    const { client } = fakeAdmin({
      hotel_memberships: [member("h-a"), member("h-b"), member("h-c")],
      hotels: [
        parked("h-a", "Sea View Inn", "2026-09-10T14:08:00Z"),
        deferred("h-b", "Bay Lodge", "2026-09-10T14:08:01Z"),
        parked("h-c", "Cliff House", "2026-09-10T14:08:02Z"),
      ],
      pms_marketplace_claims: [claim("h-a", null), claim("h-b", null), claim("h-c", null)],
    });
    const unpaid = await listUnpaidMarketplaceHotels(client, USER);
    expect(unpaid.map((u) => u.hotelId)).toEqual(["h-a", "h-c"]);
    // The public shape does not grow a deferredAt: nothing in it is deferred.
    expect(Object.keys(unpaid[0]).sort()).toEqual(["groupKey", "hotelId", "name", "pmsType", "propertyName"]);
  });

  it("offers every parked sibling, loudly, when the setup_deferred_at column has not been migrated", async () => {
    const { client } = fakeAdmin(
      {
        hotel_memberships: [member("h-a"), member("h-b")],
        hotels: [
          parked("h-a", "Sea View Inn", "2026-09-10T14:08:00Z"),
          parked("h-b", "Bay Lodge", "2026-09-10T14:08:01Z"),
        ],
        pms_marketplace_claims: [claim("h-a", null), claim("h-b", null)],
      },
      { noDeferredColumn: true },
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const unpaid = await listUnpaidMarketplaceHotels(client, USER);
    expect(unpaid.map((u) => u.hotelId)).toEqual(["h-a", "h-b"]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain("setup_deferred_v1");
    errorSpy.mockRestore();
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

describe("listDeferredMarketplaceHotels", () => {
  it("lists what was deferred, with when, and leaves the live queue alone", async () => {
    const { client } = fakeAdmin({
      hotel_memberships: [member("h-a"), member("h-b"), member("h-c"), member("h-paid")],
      hotels: [
        parked("h-a", "Sea View Inn", "2026-09-10T14:08:00Z"),
        deferred("h-b", "Bay Lodge", "2026-09-10T14:08:01Z"),
        deferred("h-c", "Cliff House", "2026-09-10T14:08:02Z"),
        // Deferred and then paid for by some other path: not owed, not listed.
        deferred("h-paid", "Paid", "2026-09-10T14:08:03Z"),
      ],
      pms_marketplace_claims: [claim("h-a", null), claim("h-b", "Bay Lodge"), claim("h-c", null), claim("h-paid", null)],
      hotel_subscriptions: [{ hotel_id: "h-paid", status: "active" }],
    });
    const list = await listDeferredMarketplaceHotels(client, USER);
    expect(list.map((d) => d.hotelId)).toEqual(["h-b", "h-c"]);
    expect(list[0]).toEqual({
      hotelId: "h-b",
      name: "Bay Lodge",
      propertyName: "Bay Lodge",
      pmsType: "cloudbeds",
      groupKey: "grp-1",
      deferredAt: DEFERRED_AT,
    });
  });

  it("ignores Flow B's placeholder and an unredeemed ticket, same as the unpaid list", async () => {
    const { client } = fakeAdmin({
      hotel_memberships: [member("h-flow-b"), member("h-ticket")],
      hotels: [
        deferred("h-flow-b", "Pending setup 1a2b3c4d", "2026-09-10T14:08:00Z"),
        deferred("h-ticket", "Sea View Inn", "2026-09-10T14:08:01Z"),
      ],
      pms_marketplace_claims: [{ ...claim("h-ticket", null), claimed_by: null, claimed_at: null }],
    });
    await expect(listDeferredMarketplaceHotels(client, USER)).resolves.toEqual([]);
  });

  it("answers empty, loudly, before the column exists", async () => {
    const { client } = fakeAdmin(
      {
        hotel_memberships: [member("h-a")],
        hotels: [parked("h-a", "Sea View Inn", "2026-09-10T14:08:00Z")],
        pms_marketplace_claims: [claim("h-a", null)],
      },
      { noDeferredColumn: true },
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(listDeferredMarketplaceHotels(client, USER)).resolves.toEqual([]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
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

  it("never adopts a property the owner said 'not now' to", async () => {
    // Once every Marketplace sibling is deferred this is the only parked row
    // left; handing it to Flow B's checkout would pay for it down the wrong
    // path. Nothing pending is the honest answer.
    const { client } = fakeAdmin({
      hotel_memberships: [member("h-deferred"), member("h-live")],
      hotels: [
        deferred("h-deferred", "Parked", "2026-09-10T14:08:00Z"),
        { id: "h-live", name: "Live", is_active: true, setup_pending_at: null, created_at: "2026-09-01T00:00:00Z" },
      ],
    });
    await expect(findPendingHotelForUser(client, USER)).resolves.toBeNull();
  });

  it("falls back to every parked row, loudly, before the setup_deferred column exists", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = fakeAdmin(
      {
        hotel_memberships: [member("h-1")],
        hotels: [parked("h-1", "Only", "2026-09-10T14:08:00Z")],
      },
      { noDeferredColumn: true },
    );
    await expect(findPendingHotelForUser(client, USER)).resolves.toBe("h-1");
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("setup_deferred_v1");
    errorSpy.mockRestore();
  });
});
