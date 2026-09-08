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

/** Only the read shapes step.ts and findPendingHotelForUser actually use. */
function client() {
  const rowsOf = (t: string) => state.tables[t] ?? [];
  const builder = (table: string) => {
    const eqs: [string, unknown][] = [];
    let notNullCol: string | null = null;
    let ins: [string, unknown[]] | null = null;
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
      maybeSingle: async () => ({ data: match()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => void) => Promise.resolve({ data: match(), error: null }).then(resolve),
    };
    const match = () =>
      rowsOf(table).filter(
        (r) =>
          eqs.every(([c, v]) => r[c] === v) &&
          (!ins || ins[1].includes(r[ins[0]])) &&
          (!notNullCol || r[notNullCol] != null),
      );
    return api;
  };
  return {
    from: builder,
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
