/**
 * The failure pages the OAuth callback can show an owner.
 *
 * Every fatal step renders a full-page apology to someone who has already paid,
 * so the same thing must hold at each of them: the page gets a plain sentence,
 * the server log gets the driver's words, and the driver's words never reach
 * the page — PostgREST and Vault name missing functions and tables outright.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

const state = vi.hoisted(() => ({
  failures: {} as Record<string, string>,
  hotelUpdates: 0,
}));

vi.mock("@/utils/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
  }),
}));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: () => fakeAdmin() }));
vi.mock("@/lib/onboarding/step", () => ({ resolveOnboardingStep: async () => "connect" }));
vi.mock("@/lib/billing/pending-hotel", () => ({ findPendingHotelForUser: async () => "hotel-1" }));
vi.mock("@/lib/billing/stripe", () => ({ isStripeConfigured: () => true }));
vi.mock("@/lib/hotel-context", () => ({ MAYA_ACTIVE_HOTEL_COOKIE: "maya_active_hotel" }));
vi.mock("@/lib/pms/onboarding-adapter", () => ({
  createOnboardingAdapter: async () => ({
    discoverProperty: async () => ({
      name: "Driftwood",
      timezone: "UTC",
      currency: "USD",
      externalPropertyId: "prop-1",
    }),
  }),
}));

/** Only the write shapes handleOnboardingConnect actually uses. */
function fakeAdmin() {
  const outcome = (key: string) =>
    state.failures[key]
      ? { data: null, error: { message: state.failures[key], code: "XX000" } }
      : { data: { id: "hotel-1" }, error: null };
  return {
    from: (table: string) => ({
      update: () => ({
        eq: () => {
          // hotels is updated twice: adoption first, activation last.
          const key =
            table === "hotels"
              ? state.hotelUpdates++ === 0
                ? "hotels.adopt"
                : "hotels.activate"
              : `${table}.update`;
          const res = outcome(key);
          return {
            select: () => ({ single: async () => res }),
            then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
              Promise.resolve(res).then(resolve, reject),
          };
        },
      }),
      insert: () => ({ select: () => ({ single: async () => outcome(`${table}.insert`) }) }),
      upsert: async () => outcome(`${table}.upsert`),
    }),
    rpc: async (fn: string) => outcome(`rpc.${fn}`),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const { handleOnboardingConnect } = await import("./connect");

const connect = () =>
  handleOnboardingConnect({} as never, "mews", "user-1", {
    accessToken: "at",
    refreshToken: "rt",
    tokenType: "Bearer",
    scope: null,
    expiresAt: "2026-08-01T00:00:00Z",
  });

const DRIVER_TEXT = "function pms_secret_set(p_hotel_id => uuid) does not exist";

let errors: MockInstance;

beforeEach(() => {
  state.failures = {};
  state.hotelUpdates = 0;
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errors.mockRestore();
  delete process.env.MAYA_INVITE_REDIRECT_BASE;
});

describe("a database failure mid-connect", () => {
  const SITES = [
    { site: "adopting the hotel row", key: "hotels.adopt", sentence: "Could not create your property." },
    { site: "writing the membership", key: "hotel_memberships.upsert", sentence: "Could not link you to your property." },
    { site: "writing settings", key: "hotel_settings.upsert", sentence: "Could not set up your pricing settings." },
    { site: "storing tokens in Vault", key: "rpc.pms_secret_set", sentence: "Could not store your connection securely." },
    { site: "recording the connection", key: "pms_connections.upsert", sentence: "Could not record your connection." },
    { site: "activating the property", key: "hotels.activate", sentence: "Could not finish setting up your property." },
  ];

  it.each(SITES)("$site: the page gets a sentence, the log gets the driver text", async ({ key, sentence }) => {
    state.failures[key] = DRIVER_TEXT;
    const res = await connect();
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain(sentence);
    expect(body).not.toContain(DRIVER_TEXT);
    expect(body).not.toContain("does not exist");
    expect(errors.mock.calls.flat().join("\n")).toContain(DRIVER_TEXT);
  });
});

describe("when every step lands", () => {
  it("redirects into onboarding with nothing logged as an error", async () => {
    process.env.MAYA_INVITE_REDIRECT_BASE = "https://app.example";
    const res = await connect();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://app.example/onboarding");
    expect(errors).not.toHaveBeenCalled();
  });
});
