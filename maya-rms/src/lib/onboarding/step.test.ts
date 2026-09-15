/**
 * Regression tests for onboarding's routing decision.
 *
 * Every screen in the flow asks this one function where the user is, so the
 * failure modes are all "shown the wrong step": a payment form to someone who
 * already paid, a PMS picker to someone who hasn't, a second signup to a property
 * that fell behind on its card. The order below is the flow's order, and the
 * cases that matter most are the ones where a subscription exists but the
 * property doesn't yet, and where it exists but has lapsed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const USER = "user-1";

const state = vi.hoisted(() => ({
  hotelId: null as string | null,
  stripe: true,
  userId: "user-1" as string | null,
  tables: {} as Record<string, Row[]>,
}));

vi.mock("@/lib/hotel-context", () => ({
  resolveAccessibleHotelId: async () => state.hotelId,
  MAYA_ACTIVE_HOTEL_COOKIE: "maya_active_hotel",
}));
vi.mock("@/lib/billing/stripe", () => ({ isStripeConfigured: () => state.stripe }));
// The self-heal for a paid Marketplace property runs under the admin client;
// same in-memory tables, so the test can see what it wrote.
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: () => client() }));

/** The read shapes step.ts and findPendingHotelForUser use, plus the writes
 *  marketplace activation makes when the router has to finish it itself. */
function client() {
  const rowsOf = (t: string) => (state.tables[t] ??= []);
  const builder = (table: string) => {
    const eqs: [string, unknown][] = [];
    const sortBy: string[] = [];
    let notNullCol: string | null = null;
    let ins: [string, unknown[]] | null = null;
    let mode: "select" | "update" | "insert" | "upsert" = "select";
    let patch: Row | null = null;
    let rows: Row[] = [];
    const match = () =>
      rowsOf(table).filter(
        (r) =>
          eqs.every(([c, v]) => r[c] === v) &&
          (!ins || ins[1].includes(r[ins[0]])) &&
          (!notNullCol || r[notNullCol] != null),
      );
    const exec = (): Row[] => {
      if (mode === "update") {
        const m = match();
        for (const r of m) Object.assign(r, patch);
        return m;
      }
      if (mode === "insert") {
        const out = rows.map((r) => ({ id: `${table}-${rowsOf(table).length + 1}`, ...r }));
        rowsOf(table).push(...out);
        return out;
      }
      if (mode === "upsert") {
        rowsOf(table).push(...rows);
        return rows;
      }
      const m = match();
      return sortBy.length
        ? [...m].sort((a, b) => {
            for (const col of sortBy) {
              const c = String(a[col] ?? "").localeCompare(String(b[col] ?? ""));
              if (c !== 0) return c;
            }
            return 0;
          })
        : m;
    };
    const api = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        eqs.push([col, val]);
        return api;
      },
      in: (col: string, vals: unknown[]) => {
        ins = [col, vals];
        return api;
      },
      not: (col: string) => {
        notNullCol = col;
        return api;
      },
      limit: () => api,
      order: (col: string) => {
        sortBy.push(col);
        return api;
      },
      update: (p: Row) => {
        mode = "update";
        patch = p;
        return api;
      },
      insert: (r: Row | Row[]) => {
        mode = "insert";
        rows = Array.isArray(r) ? r : [r];
        return api;
      },
      upsert: (r: Row | Row[]) => {
        mode = "upsert";
        rows = Array.isArray(r) ? r : [r];
        return api;
      },
      maybeSingle: async () => ({ data: exec()[0] ?? null, error: null }),
      single: async () => ({ data: exec()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => void) => Promise.resolve({ data: exec(), error: null }).then(resolve),
    };
    return api;
  };
  return {
    from: builder,
    rpc: async () => ({ data: null, error: null }),
    auth: {
      getSession: async () => ({
        data: { session: state.userId ? { user: { id: state.userId } } : null },
      }),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const { resolveOnboardingStep } = await import("./step");
const step = () => resolveOnboardingStep(client());

const pendingHotel = (id = "hotel-pending") => ({
  hotels: [{ id, setup_pending_at: "2026-07-01T00:00:00Z" }],
  hotel_memberships: [{ hotel_id: id, user_id: USER, status: "active" }],
});

beforeEach(() => {
  state.hotelId = null;
  state.stripe = true;
  state.userId = USER;
  state.tables = {};
});

describe("before there is a property", () => {
  it("asks a brand-new account to pay", async () => {
    await expect(step()).resolves.toBe("subscribe");
  });

  it("asks again when checkout was started but never finished", async () => {
    state.tables = pendingHotel();
    await expect(step()).resolves.toBe("subscribe");
  });

  it("moves to the PMS once the payment has landed", async () => {
    state.tables = {
      ...pendingHotel(),
      hotel_subscriptions: [{ hotel_id: "hotel-pending", status: "trialing" }],
    };
    await expect(step()).resolves.toBe("connect");
  });

  it("carries a property through a failed card into the PMS step", async () => {
    // past_due is entitled on purpose (see sync.ts): Stripe retries for about a
    // fortnight, and restarting someone's signup over one declined charge is a
    // worse outcome than a banner.
    state.tables = {
      ...pendingHotel(),
      hotel_subscriptions: [{ hotel_id: "hotel-pending", status: "past_due" }],
    };
    await expect(step()).resolves.toBe("connect");
  });

  it("goes back to payment once the retries have run out", async () => {
    state.tables = {
      ...pendingHotel(),
      hotel_subscriptions: [{ hotel_id: "hotel-pending", status: "canceled" }],
    };
    await expect(step()).resolves.toBe("subscribe");
  });

  it("skips payment entirely on a deployment with no Stripe keys", async () => {
    // Asking for a card that cannot be taken is a dead end, so those installs
    // onboard straight into the PMS connect.
    state.stripe = false;
    await expect(step()).resolves.toBe("connect");
  });

  it("makes a paid Marketplace property live and offers the path choice — it already has a PMS", async () => {
    // The webhook normally activates it before any page asks. When a page
    // gets there first, sending a connected property to the PMS picker would
    // connect it a second time, so the router finishes the job itself.
    state.tables = {
      ...pendingHotel(),
      hotels: [{ id: "hotel-pending", is_active: false, setup_pending_at: "2026-09-10T14:08:00Z" }],
      hotel_subscriptions: [{ hotel_id: "hotel-pending", status: "trialing" }],
      pms_connections: [{ hotel_id: "hotel-pending", pms_type: "cloudbeds", status: "pending" }],
      pms_marketplace_claims: [
        {
          token: "tok",
          hotel_id: "hotel-pending",
          pms_type: "cloudbeds",
          property_name: "Sea View Inn",
          claimed_by: USER,
          claimed_at: "2026-09-10T14:09:00Z",
        },
      ],
    };
    await expect(step()).resolves.toBe("choose");
    expect(state.tables.hotels[0]).toMatchObject({ is_active: true, setup_pending_at: null });
    expect(state.tables.pms_connections[0]).toMatchObject({ status: "connected" });
    expect(state.tables.import_jobs).toHaveLength(1);
  });
});

describe("once the PMS connect has adopted the property", () => {
  it("offers the choice of how much help they want", async () => {
    state.hotelId = "hotel-real";
    await expect(step()).resolves.toBe("choose");
  });

  it("stops offering it once they have chosen", async () => {
    state.hotelId = "hotel-real";
    state.tables = { profiles: [{ id: USER, onboarding_path: "guided" }] };
    await expect(step()).resolves.toBe("done");
  });

  it("treats a dismissal from an older build as a choice already made", async () => {
    state.hotelId = "hotel-real";
    state.tables = {
      profiles: [{ id: USER, onboarding_path: null, onboarding_dismissed_at: "2026-07-01T00:00:00Z" }],
    };
    await expect(step()).resolves.toBe("done");
  });

  it("asks for payment on a Marketplace sibling that is still parked, even with a live property", async () => {
    // A group grant parks several properties; the first one paid went live.
    // Without this the live property wins the routing and the second is never
    // offered a checkout — the loop only closes if the router notices it.
    state.hotelId = "hotel-real";
    state.tables = {
      profiles: [{ id: USER, onboarding_path: "guided" }],
      hotels: [{ id: "hotel-sibling", is_active: false, setup_pending_at: "2026-09-10T14:08:00Z", created_at: "2026-09-10T14:08:00Z" }],
      hotel_memberships: [
        { hotel_id: "hotel-real", user_id: USER, status: "active" },
        { hotel_id: "hotel-sibling", user_id: USER, status: "active" },
      ],
      pms_marketplace_claims: [
        {
          token: "tok-2",
          hotel_id: "hotel-sibling",
          pms_type: "cloudbeds",
          property_name: "Bay Lodge",
          claimed_by: USER,
          claimed_at: "2026-09-10T14:09:00Z",
          group_key: "grp-1",
        },
      ],
    };
    await expect(step()).resolves.toBe("subscribe");
  });

  it("does not mistake a Flow B placeholder beside a live property for an unpaid sibling", async () => {
    // Same shape as the sibling above, but no claim row: that is the row a
    // Flow B checkout leaves for the PMS connect to adopt, and it is not owed a
    // second payment.
    state.hotelId = "hotel-real";
    state.tables = {
      profiles: [{ id: USER, onboarding_path: "guided" }],
      hotels: [{ id: "hotel-placeholder", is_active: false, setup_pending_at: "2026-09-10T14:08:00Z" }],
      hotel_memberships: [
        { hotel_id: "hotel-real", user_id: USER, status: "active" },
        { hotel_id: "hotel-placeholder", user_id: USER, status: "active" },
      ],
    };
    await expect(step()).resolves.toBe("done");
  });

  it("stops asking once every sibling is paid for", async () => {
    state.hotelId = "hotel-real";
    state.tables = {
      profiles: [{ id: USER, onboarding_path: "guided" }],
      hotels: [{ id: "hotel-sibling", is_active: false, setup_pending_at: "2026-09-10T14:08:00Z" }],
      hotel_memberships: [
        { hotel_id: "hotel-real", user_id: USER, status: "active" },
        { hotel_id: "hotel-sibling", user_id: USER, status: "active" },
      ],
      pms_marketplace_claims: [
        { token: "tok-2", hotel_id: "hotel-sibling", pms_type: "cloudbeds", claimed_by: USER, claimed_at: "2026-09-10T14:09:00Z" },
      ],
      hotel_subscriptions: [{ hotel_id: "hotel-sibling", status: "trialing" }],
    };
    await expect(step()).resolves.toBe("done");
  });

  it("does not re-open signup for a property that has fallen behind on payment", async () => {
    // The dunning banner owns a lapsed subscription. Sending them round the
    // onboarding loop again would end in a second subscription.
    state.hotelId = "hotel-real";
    state.tables = {
      profiles: [{ id: USER, onboarding_path: "guided" }],
      hotel_subscriptions: [{ hotel_id: "hotel-real", status: "unpaid" }],
    };
    await expect(step()).resolves.toBe("done");
  });
});
