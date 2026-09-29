/**
 * The restart screen starts a brand new subscription. Only a subscription
 * that is gone in Stripe may reach it: a new one beside a live, unpaid or
 * paused one would bill the property twice.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import type { AccountBilling } from "@/lib/billing/account";

const state = vi.hoisted(() => ({ billing: null as AccountBilling | null }));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));
vi.mock("@/utils/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from: () => ({
      select: () => ({
        eq: () => ({
          order: async () => ({ data: [{ pms_type: "cloudbeds", status: "connected" }], error: null }),
        }),
      }),
    }),
  }),
}));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: () => ({}), isAdminConfigured: () => true }));
vi.mock("@/lib/hotel-context", () => ({ resolveAccessibleHotelId: async () => "hotel-1" }));
vi.mock("@/lib/require-supabase-hotel", () => ({ hasHotelRank: async () => true }));
vi.mock("@/lib/billing/pms-gates", () => ({ pmsSignupCodeRequired: async () => false }));
vi.mock("@/lib/billing/account", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/billing/account")>()),
  loadAccountBilling: async () => state.billing,
}));
vi.mock("@/components/onboarding/subscribe-step", () => ({ SubscribeStep: () => null }));
vi.mock("@/components/brand/logo", () => ({ MayaLockup: () => null }));

const { default: RestartPage } = await import("./page");
const { SubscribeStep } = await import("@/components/onboarding/subscribe-step");

function billing(o: Partial<AccountBilling> = {}): AccountBilling {
  return {
    hotelId: "hotel-1",
    status: "canceled",
    interval: "month",
    rooms: 24,
    periodCents: 13_200,
    chargeCents: null,
    codeApplied: false,
    renewsAt: null,
    unpaidSince: null,
    trialEndsAt: null,
    cancelAtPeriodEnd: false,
    cardTrouble: null,
    signupCode: null,
    entitled: false,
    roomTruth: { kind: "ok", measured: 24, billed: 24 },
    roomGraceDaysLeft: null,
    notBilledFor: [],
    allRoomTypesExcluded: false,
    ...o,
  };
}

/** Every element in the tree, depth first. */
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  return [el, ...elements(el.props.children as ReactNode)];
}

beforeEach(() => {
  state.billing = null;
});

describe("the restart screen", () => {
  it("opens for a cancelled subscription", async () => {
    state.billing = billing();
    const tree = elements(await RestartPage());
    expect(tree.some((e) => e.type === SubscribeStep)).toBe(true);
  });

  it("sends an unpaid subscription back to billing, where the card revives it", async () => {
    state.billing = billing({ status: "unpaid" });
    await expect(RestartPage()).rejects.toThrow("redirect /account/billing");
  });

  it("sends a paused or live subscription back to billing too", async () => {
    for (const b of [billing({ status: "paused" }), billing({ status: "active", entitled: true })]) {
      state.billing = b;
      await expect(RestartPage(), b.status).rejects.toThrow("redirect /account/billing");
    }
  });
});
