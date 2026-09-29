/**
 * The dashboard banner only knows what this route sends. The subject line is
 * what turns its button into an email to us, so it has to come through.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountBilling } from "@/lib/billing/account";

const state = vi.hoisted(() => ({ billing: null as AccountBilling | null }));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/server", () => ({ createClient: () => ({}) }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/lib/require-supabase-hotel", () => ({
  requireSupabaseHotel: async () => ({ ok: true, supabase: {}, hotelId: "hotel-1" }),
}));
vi.mock("@/lib/billing/account", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/billing/account")>()),
  loadAccountBilling: async () => state.billing,
}));

const { GET } = await import("./route");

function billing(o: Partial<AccountBilling> = {}): AccountBilling {
  return {
    hotelId: "hotel-1",
    status: "active",
    interval: "month",
    rooms: 40,
    periodCents: 20_000,
    chargeCents: null,
    codeApplied: false,
    renewsAt: null,
    unpaidSince: null,
    trialEndsAt: null,
    cancelAtPeriodEnd: false,
    cardTrouble: null,
    signupCode: null,
    entitled: true,
    roomTruth: { kind: "ok", measured: 40, billed: 40 },
    roomGraceDaysLeft: null,
    notBilledFor: [],
    allRoomTypesExcluded: false,
    ...o,
  };
}

const read = async () => (await GET(new Request("http://localhost/api/billing/status"))).json();

beforeEach(() => {
  state.billing = null;
});

describe("GET /api/billing/status", () => {
  it("passes the email subject through for a paused subscription", async () => {
    state.billing = billing({ status: "paused", entitled: false });
    expect(await read()).toMatchObject({
      applicable: true,
      tone: "stopped",
      emailSubject: "Paused subscription",
    });
  });

  it("sends no subject when the billing page is the way forward", async () => {
    state.billing = billing({ status: "canceled", entitled: false });
    expect(await read()).toMatchObject({ applicable: true, tone: "stopped", emailSubject: null });
  });

  it("stays quiet for a property with no subscription", async () => {
    expect(await read()).toEqual({ applicable: false });
  });
});
