/**
 * What the Billing page says, rendered to text. Owners read these sentences
 * when something is wrong with what they pay, so they stay plain: no em dash
 * in the status, the card warning, the room count line or the hand-made
 * property's note.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AccountBilling } from "@/lib/billing/account";

const state = vi.hoisted(() => ({ billing: null as AccountBilling | null }));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@/utils/supabase/server", () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) } }),
}));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: () => ({}), isAdminConfigured: () => false }));
vi.mock("@/lib/hotel-context", () => ({ resolveAccessibleHotelId: async () => "hotel-1" }));
vi.mock("@/lib/require-supabase-hotel", () => ({ hasHotelRank: async () => true }));
vi.mock("@/lib/billing/pending-hotel", () => ({ listDeferredMarketplaceHotels: async () => [] }));
vi.mock("@/lib/billing/account", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/billing/account")>()),
  loadAccountBilling: async () => state.billing,
}));
vi.mock("@/components/billing/billing-actions", () => ({ ManageBillingButton: () => null, RoomCountForm: () => null }));
vi.mock("@/components/billing/deferred-properties", () => ({ DeferredProperties: () => null }));
vi.mock("@/components/deep-links/arrival-bits", () => ({ ArrivalFlash: () => null }));
vi.mock("@/components/deep-links/help-links", () => ({ HelpLink: () => null, LearnMore: () => null }));
vi.mock("@/components/brand/logo", () => ({ MayaLockup: () => null }));

const { default: BillingPage } = await import("./page");

function billing(o: Partial<AccountBilling> = {}): AccountBilling {
  return {
    hotelId: "hotel-1",
    status: "active",
    interval: "month",
    rooms: 24,
    periodCents: 13_200,
    chargeCents: null,
    chargeBeforeTaxCents: null,
    codeApplied: false,
    renewsAt: "2026-10-29T00:00:00Z",
    unpaidSince: null,
    trialEndsAt: null,
    cancelAtPeriodEnd: false,
    cardTrouble: null,
    signupCode: null,
    entitled: true,
    roomTruth: { kind: "ok", measured: 24, billed: 24 },
    roomGraceDaysLeft: null,
    notBilledFor: [],
    allRoomTypesExcluded: false,
    ...o,
  };
}

/** The page as text, with the markup stripped. */
async function pageText(): Promise<string> {
  return renderToStaticMarkup(await BillingPage())
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

beforeEach(() => {
  state.billing = null;
});

describe("the billing page's words", () => {
  it("labels an unpaid subscription without a dash", async () => {
    state.billing = billing({ status: "unpaid", entitled: false });
    const text = await pageText();
    expect(text).toContain("Unpaid (stopped)");
    expect(text).not.toContain("—");
  });

  it("warns about a card and an over-count in plain sentences", async () => {
    state.billing = billing({
      cardTrouble: { code: "insufficient_funds", since: "2026-09-20T00:00:00Z" },
      roomTruth: { kind: "over", measured: 20, billed: 24, overBy: 4 },
    });
    const text = await pageText();
    expect(text).toContain("Nothing has failed yet, and updating it now avoids an interruption.");
    expect(text).toContain("You're paying for more than that. Lower it here and your next invoice drops.");
    expect(text).not.toContain("—");
  });

  it("explains a property with no subscription without a dash", async () => {
    const text = await pageText();
    expect(text).toContain(
      "This property has no subscription. It was set up by hand rather than through checkout, so there is nothing to bill or manage here.",
    );
    expect(text).not.toContain("—");
  });
});
