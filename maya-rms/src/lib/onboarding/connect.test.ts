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
  discoverThrows: null as Error | null,
  currency: "USD" as string | null,
  writes: [] as string[],
  rpcs: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  elsewhere: null as null | { propertyId: string; hotelId: string; name: string | null; via: string; connectionStatus: string | null },
  elsewhereThrows: null as Error | null,
  elsewhereAsked: [] as Array<{ hotelId: string | null; pmsType: string; propertyIds: string[] }>,
  stripe: true,
  propertyId: "prop-1",
  hotelPayloads: [] as Record<string, unknown>[],
}));

vi.mock("@/utils/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
  }),
}));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: () => fakeAdmin() }));
vi.mock("@/lib/onboarding/step", () => ({ resolveOnboardingStep: async () => "connect" }));
vi.mock("@/lib/billing/pending-hotel", () => ({ findPendingHotelForUser: async () => "hotel-1" }));
vi.mock("@/lib/billing/stripe", () => ({ isStripeConfigured: () => state.stripe }));
vi.mock("@/lib/pms/stored-property", () => ({
  propertyBelongsElsewhere: async (_admin: unknown, hotelId: string | null, pmsType: string, propertyIds: string[]) => {
    state.elsewhereAsked.push({ hotelId, pmsType, propertyIds });
    if (state.elsewhereThrows) throw state.elsewhereThrows;
    return state.elsewhere;
  },
}));
vi.mock("@/lib/hotel-context", () => ({ MAYA_ACTIVE_HOTEL_COOKIE: "maya_active_hotel" }));
vi.mock("@/lib/pms/onboarding-adapter", () => ({
  createOnboardingAdapter: async () => ({
    discoverProperty: async () => {
      if (state.discoverThrows) throw state.discoverThrows;
      return {
        name: "Driftwood",
        timezone: "UTC",
        currency: state.currency,
        externalPropertyId: state.propertyId,
      };
    },
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
      update: (payload: Record<string, unknown>) => ({
        eq: () => {
          if (table === "hotels") state.hotelPayloads.push(payload);
          state.writes.push(`${table}.update`);
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
      insert: () => {
        state.writes.push(`${table}.insert`);
        return { select: () => ({ single: async () => outcome(`${table}.insert`) }) };
      },
      upsert: async () => {
        state.writes.push(`${table}.upsert`);
        return outcome(`${table}.upsert`);
      },
    }),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.rpcs.push({ fn, args });
      return outcome(`rpc.${fn}`);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const { handleOnboardingConnect } = await import("./connect");
const { AmbiguousGroupGrantError } = await import(
  "../../../supabase/functions/_shared/pms/errors"
);

const connect = (pms: "mews" | "cloudbeds" = "mews") =>
  handleOnboardingConnect({} as never, pms, "user-1", {
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
  state.discoverThrows = null;
  state.currency = "USD";
  state.writes = [];
  state.rpcs = [];
  state.elsewhere = null;
  state.elsewhereThrows = null;
  state.elsewhereAsked = [];
  state.stripe = true;
  state.propertyId = "prop-1";
  state.hotelPayloads = [];
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

describe("a property in a currency MAYA doesn't price in yet (audits A20, A58)", () => {
  it("is stopped with a plain line before anything is written, and the refusal is counted", async () => {
    state.currency = "KRW";
    const res = await connect();
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("Your property's system uses KRW. MAYA doesn't price in KRW yet, so nothing was set up or imported.");
    expect(body).toContain("Reply to your receipt and we'll sort out your payment.");
    expect(body).not.toContain("Try again");
    expect(body).not.toContain("—");
    // Never half set up: no row adopted, no credential, connection or import.
    expect(state.writes).toEqual([]);
    expect(state.rpcs.map((r) => r.fn)).toEqual(["product_event_emit"]);
    expect(state.rpcs[0].args).toMatchObject({
      p_event: "pms.currency_refused",
      p_hotel_id: "hotel-1",
      p_user_id: "user-1",
      // Paid at checkout: the database also posts it to #maya-signups.
      p_properties: { currency: "KRW", via: "onboarding_oauth", paid: true },
      p_pms_type: "mews",
      p_pms_property_id: "prop-1",
    });
  });

  it.each(["USD", "eur", "GBP", "CAD", "AUD", "NZD", "CHF", null])("lets %s through", async (currency) => {
    state.currency = currency;
    process.env.MAYA_INVITE_REDIRECT_BASE = "https://maya.test";
    const res = await connect();
    expect(res.status).toBe(302);
    expect(state.rpcs.some((r) => r.fn === "product_event_emit")).toBe(false);
  });
});

describe("a login that covers a whole group", () => {
  it("says how many properties it saw and who to talk to, without a retry that would fail the same way", async () => {
    // Discovery cannot pick one of several properties without guessing, and a
    // wrong guess pushes rates to the wrong hotel. The owner has paid and done
    // nothing wrong, so the page names the situation instead of the driver.
    state.discoverThrows = new AmbiguousGroupGrantError(3, "Cloudbeds");
    const res = await connect();
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("This Cloudbeds login covers 3 properties.");
    expect(body).toContain("reply to your receipt or email us");
    expect(body).not.toContain("Try again");
    expect(body).not.toContain("couldn't read your property details");
    // Never the Marketplace: it would park separate hotels beside the one they paid for.
    expect(body).not.toContain("Marketplace");
  });

  it("names the PMS it came from", async () => {
    state.discoverThrows = new AmbiguousGroupGrantError(2, "Think Reservations");
    const body = await (await connect()).text();
    expect(body).toContain("This Think Reservations login covers 2 properties.");
  });

  it("leaves every other discovery failure on the generic page, retry included", async () => {
    state.discoverThrows = new Error("Cloudbeds: could not discover propertyID for this account.");
    const body = await (await connect()).text();
    expect(body).toContain("couldn't read your property details");
    expect(body).toContain("Try again");
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

describe("a property that is already in MAYA (audit A23)", () => {
  it("asks about the property it discovered, for the hotel checkout made, before anything is stored", async () => {
    process.env.MAYA_INVITE_REDIRECT_BASE = "https://app.example";
    const res = await connect();
    expect(res.status).toBe(302);
    expect(state.elsewhereAsked).toEqual([{ hotelId: "hotel-1", pmsType: "mews", propertyIds: ["prop-1"] }]);
  });

  it("is refused with the invitation wording, nothing written, and support told which hotel holds it", async () => {
    state.elsewhere = { propertyId: "prop-1", hotelId: "hotel-9", name: "Harbour Inn", via: "credential", connectionStatus: "connected" };
    const res = await connect();
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("This Mews property is already in MAYA, so nothing new was added.");
    expect(body).toContain("Ask its General Manager to invite you, or email us.");
    expect(body).toContain("Reply to your receipt and we'll sort out your payment.");
    expect(body).not.toContain("Try again");
    expect(body).not.toContain("—");
    // The other hotel is named for support only.
    expect(body).not.toContain("Harbour Inn");
    expect(state.writes).toEqual([]);
    expect(state.rpcs).toEqual([]);
    const log = errors.mock.calls.flat().join("\n");
    expect(log).toContain('"blockingHotelId":"hotel-9"');
    expect(log).toContain('"refused":true');
  });

  it("says nothing about payment on an install that takes none", async () => {
    state.stripe = false;
    state.elsewhere = { propertyId: "prop-1", hotelId: "hotel-9", name: null, via: "marketplace", connectionStatus: null };
    const body = await (await connect()).text();
    expect(body).toContain("already in MAYA");
    expect(body).not.toContain("payment");
  });

  it("stops with a retry when the check itself cannot be made, never taking an outage for 'not in MAYA'", async () => {
    state.elsewhereThrows = new Error("pms_secret_get: permission denied for function");
    const res = await connect();
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("We couldn't check this property just now.");
    expect(body).toContain("Try again");
    expect(body).not.toContain("permission denied");
    expect(state.writes).toEqual([]);
  });
});

describe("a vendor's sandbox property", () => {
  it("is a test property from the moment the placeholder is adopted", async () => {
    state.propertyId = "320691";
    process.env.MAYA_INVITE_REDIRECT_BASE = "https://app.example";
    await connect("cloudbeds");
    expect(state.hotelPayloads[0]).toMatchObject({ name: "Driftwood", is_test: true });
  });

  it("leaves any other property a real one, and the same id on another system", async () => {
    process.env.MAYA_INVITE_REDIRECT_BASE = "https://app.example";
    await connect("cloudbeds");
    expect(state.hotelPayloads[0]).not.toHaveProperty("is_test");
    state.hotelPayloads = [];
    state.hotelUpdates = 0;
    state.propertyId = "320691";
    await connect("mews");
    expect(state.hotelPayloads[0]).not.toHaveProperty("is_test");
  });
});
