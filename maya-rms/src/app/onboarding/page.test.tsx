/**
 * A never-paid Marketplace property whose data the retention sweep removed
 * comes back to the subscribe screen with no connection. It must not say it is
 * connected, and the owner gets the ordinary reconnect prompt above the same
 * screen, so paying is still one click away.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { fakeSupabase } from "@/lib/engine/fake-supabase.test";

const state = vi.hoisted(() => ({
  admin: null as unknown as ReturnType<typeof import("@/lib/engine/fake-supabase.test").fakeSupabase>,
  queued: [] as string[],
}));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`redirect ${to}`); } }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/server", () => ({
  createClient: () => ({ auth: { getSession: async () => ({ data: { session: { user: { id: "user-1" } } } }) } }),
}));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: () => state.admin.client }));
vi.mock("@/lib/onboarding/step", () => ({
  resolveOnboardingStep: async () => "subscribe",
  pendingBillingOffer: async () => null,
}));
vi.mock("@/lib/hotel-context", () => ({ resolveAccessibleHotelId: async () => null }));
vi.mock("@/lib/billing/pending-hotel", () => ({
  listUnpaidMarketplaceHotels: async () => [
    { hotelId: "hotel-1", name: "Sea View Inn", propertyName: "Sea View Inn", pmsType: "cloudbeds", groupKey: null },
  ],
}));
vi.mock("@/lib/billing/pms-gates", () => ({ listPmsSignupGates: async () => [] }));
vi.mock("@/lib/pms/eager-import", () => ({
  queuePrePaymentImport: async (_admin: unknown, hotelId: string) => {
    state.queued.push(hotelId);
    return { queued: false, reason: "no_connection" };
  },
}));
vi.mock("@/lib/pms/marketplace-activate", () => ({ marketplaceTrialDays: () => 14 }));
vi.mock("@/components/onboarding/path-choice", () => ({ PathChoice: () => null }));
vi.mock("@/components/onboarding/subscribe-step", () => ({ SubscribeStep: () => null }));
vi.mock("@/components/pms-reconnect", () => ({ PmsReconnect: () => null }));

const { default: OnboardingPage } = await import("./page");
const { SubscribeStep } = await import("@/components/onboarding/subscribe-step");
const { PmsReconnect } = await import("@/components/pms-reconnect");

/** Every element in the tree, depth first. */
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  return [el, ...elements(el.props.children as ReactNode)];
}

function world(opts: { connection: string | null; purged: boolean }) {
  state.queued = [];
  state.admin = fakeSupabase({
    hotels: [{ id: "hotel-1", is_active: false, data_purged_at: opts.purged ? "2027-03-01T00:00:00.000Z" : null }],
    pms_marketplace_claims: [
      { hotel_id: "hotel-1", pms_type: "cloudbeds", claimed_by: "user-1", claimed_at: "2026-09-01T00:00:00.000Z" },
    ],
    pms_connections: opts.connection ? [{ hotel_id: "hotel-1", pms_type: "cloudbeds", status: opts.connection }] : [],
  });
}

const render = async () => elements(await OnboardingPage({ searchParams: Promise.resolve({}) }));

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("the subscribe screen for a Marketplace arrival", () => {
  it("shows the reconnect prompt, and does not say it is connected, once the connection is gone", async () => {
    world({ connection: null, purged: true });
    const tree = await render();
    expect(tree[0].type).toBe(Fragment);

    const prompt = tree.find((e) => e.type === PmsReconnect)!;
    expect(prompt.props).toMatchObject({
      hotelId: "hotel-1",
      pmsType: "cloudbeds",
      status: "disconnected",
      authKind: "oauth2_authorization_code",
      displayName: "Cloudbeds",
      canManage: true,
      placement: "banner",
      historyRemoved: true,
    });
    const subscribe = tree.find((e) => e.type === SubscribeStep)!;
    expect(subscribe.props.title).toBe("Sea View Inn");
    expect(subscribe.props.hotelId).toBe("hotel-1");
  });

  it("is the usual screen while the property is still connected", async () => {
    world({ connection: "pending", purged: false });
    const tree = await render();
    expect(tree.some((e) => e.type === PmsReconnect)).toBe(false);
    expect(tree[0].type).toBe(SubscribeStep);
    expect(tree[0].props.title).toBe("Sea View Inn is connected");
    expect(state.queued).toEqual(["hotel-1"]);
  });
});
