/**
 * The reconnect prompt's button starts MAYA's own OAuth flow for the property
 * (/api/pms/cloudbeds/connect?hotelId=...), so the callback's hotel branch is
 * the other door a returning Marketplace owner comes back through. It has to
 * agree with the Marketplace reconnect: an unpaid property comes back parked,
 * one whose never-paid data was removed gets a fresh full import, and the
 * login has to reach the Cloudbeds property the hotel is bound to, whose ID is
 * stored with the credential again (the sweep deleted the old one).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeRpcError, fakeSupabase, type FakeRow } from "../engine/fake-supabase.test";

const state = vi.hoisted(() => ({
  stripe: true,
  db: null as unknown as ReturnType<typeof import("../engine/fake-supabase.test").fakeSupabase>,
  rpcs: [] as { fn: string; args: Record<string, unknown> }[],
  properties: [{ propertyId: "320691", name: "Sea View Inn" }] as { propertyId: string; name: string | null }[],
  listFails: false,
  claimsReadFails: false,
  /** The property ID kept with the hotel's current credential, if any. */
  storedProperty: null as string | null,
  secretReadFails: false,
  from: undefined as "admin" | undefined,
  /** The state was signed for MAYA staff in God Mode. */
  support: false,
  /** can_manage_finances for the person at the browser when the vendor sends them back. */
  stillAllowed: true,
  ssrRpcs: [] as string[],
  /** Who is signed in at the browser when the vendor sends them back; null is signed out. */
  browserUserId: "user-1" as string | null,
  /** Other hotels' rows, for the "already another hotel's" check. */
  otherHotels: [] as FakeRow[],
  otherMemberships: [] as FakeRow[],
  otherConnections: [] as FakeRow[],
  /** Property IDs stored with other hotels' credentials, by hotel id. */
  otherStoredProperties: {} as Record<string, string>,
}));

vi.mock("@/lib/billing/stripe", () => ({ isStripeConfigured: () => state.stripe }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: () => state.db.client }));
vi.mock("@/utils/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: state.browserUserId ? { id: state.browserUserId } : null } }) },
    rpc: async (fn: string) => {
      state.ssrRpcs.push(fn);
      return { data: fn === "can_manage_finances" ? state.stillAllowed : null, error: null };
    },
  }),
}));
vi.mock("@/lib/pms/cloudbeds-webhooks", () => ({ ensureAppStateWebhook: async () => ({ ok: true }) }));
vi.mock("../../../supabase/functions/_shared/cloudbeds/client", () => ({
  cloudbedsListPropertiesOrThrow: async () => {
    if (state.listFails) throw new Error("Cloudbeds 503");
    return state.properties;
  },
}));
vi.mock("@/lib/onboarding/connect", () => ({ handleOnboardingConnect: async () => new Response() }));
vi.mock("@/lib/pms/oauth-state", () => ({
  signOnboardingState: () => "s",
  signState: () => "s",
  verifyState: () => ({
    ok: true,
    intent: "hotel",
    hotelId: "hotel-1",
    userId: "user-1",
    pmsType: "cloudbeds",
    ...(state.from ? { from: state.from } : {}),
    ...(state.support ? { support: true } : {}),
  }),
}));

const { handleOAuthCallback } = await import("./oauth-flow");
const { links } = await import("@/lib/deep-links");
const { NOTE_TEXT } = await import("@/lib/deep-links/notes");

type Cookies = Parameters<typeof handleOAuthCallback>[0];

function property(opts: {
  claimed: boolean;
  purged: boolean;
  isActive?: boolean;
  subscription?: string;
  /** Connected from inside MAYA: no Marketplace key on the row. */
  inApp?: boolean;
  connection?: string;
  jobs?: FakeRow[];
}) {
  state.db = fakeSupabase({
    hotels: [
      {
        id: "hotel-1",
        name: "Sea View Inn",
        external_enterprise_id: opts.inApp ? null : "cloudbeds:320691",
        created_at: "2026-09-01T00:00:00.000Z",
        is_active: opts.isActive ?? false,
        setup_pending_at: opts.isActive ? null : "2026-09-01T00:00:00.000Z",
        setup_deferred_at: null,
        data_purged_at: opts.purged ? "2027-03-01T00:00:00.000Z" : null,
      },
      ...state.otherHotels,
    ],
    pms_marketplace_claims: opts.claimed
      ? [{ token: "tok", hotel_id: "hotel-1", pms_type: "cloudbeds", claimed_by: "user-1", claimed_at: "2026-09-01T00:00:00.000Z" }]
      : [],
    hotel_memberships: [{ hotel_id: "hotel-1", user_id: "user-1", status: "active" }, ...state.otherMemberships],
    hotel_subscriptions: opts.subscription ? [{ hotel_id: "hotel-1", status: opts.subscription }] : [],
    pms_connections: [
      ...(opts.connection
        ? [{ hotel_id: "hotel-1", pms_type: "cloudbeds", status: opts.connection, updated_at: "2026-09-01T00:00:00.000Z" }]
        : []),
      ...state.otherConnections,
    ],
    import_jobs: opts.jobs ?? [],
    onboarding_states: [],
  }, {
    fault: (c) =>
      state.claimsReadFails && c.table === "pms_marketplace_claims" ? { message: "connection reset", code: "08006" } : null,
    rpc: (fn, args) => {
      state.rpcs.push({ fn, args: args as Record<string, unknown> });
      if (fn === "pms_secret_get") {
        if (state.secretReadFails) return new FakeRpcError({ message: "vault unavailable" });
        const hotel = String((args as { p_hotel_id: unknown }).p_hotel_id);
        if (hotel !== "hotel-1") {
          const other = state.otherStoredProperties[hotel];
          return other ? { accessToken: "theirs", propertyId: other } : null;
        }
        return state.storedProperty ? { accessToken: "old", propertyId: state.storedProperty } : null;
      }
      return null;
    },
  });
  return state.db;
}

async function callback() {
  return handleOAuthCallback({} as Cookies, "cloudbeds", new URLSearchParams({ code: "abc", state: "signed" }));
}

const storedSecret = () => state.rpcs.find((r) => r.fn === "pms_secret_set")?.args.p_secret as
  | Record<string, unknown>
  | undefined;

beforeEach(() => {
  state.stripe = true;
  state.rpcs = [];
  state.properties = [{ propertyId: "320691", name: "Sea View Inn" }];
  state.listFails = false;
  state.claimsReadFails = false;
  state.storedProperty = null;
  state.secretReadFails = false;
  state.from = undefined;
  state.support = false;
  state.stillAllowed = true;
  state.ssrRpcs = [];
  state.browserUserId = "user-1";
  state.otherHotels = [];
  state.otherMemberships = [];
  state.otherConnections = [];
  state.otherStoredProperties = {};
  process.env.CLOUDBEDS_CLIENT_ID = "id";
  process.env.CLOUDBEDS_CLIENT_SECRET = "secret";
  process.env.MAYA_INVITE_REDIRECT_BASE = "https://app.example";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("access_token")) {
        return new Response(
          JSON.stringify({ access_token: "cbat", refresh_token: "cbrt", expires_in: 3600, token_type: "Bearer" }),
          { status: 200 },
        );
      }
      return new Response("", { status: 200 });
    }),
  );
});

describe("the reconnect prompt's OAuth callback", () => {
  it("brings an unpaid purged property back parked, with a fresh full import queued", async () => {
    const db = property({ claimed: true, purged: true });
    const res = await callback();
    expect(res.status).toBe(302);
    expect(db.tables.pms_connections[0]).toMatchObject({ hotel_id: "hotel-1", status: "pending" });
    expect(db.tables.import_jobs).toHaveLength(1);
    expect(db.tables.import_jobs[0]).toMatchObject({ status: "queued", phase: "discover", requested_by: "user-1" });
  });

  it("connects a paid purged property and imports it again", async () => {
    const db = property({ claimed: true, purged: true, isActive: true, subscription: "active" });
    await callback();
    expect(db.tables.pms_connections[0].status).toBe("connected");
    expect(db.tables.import_jobs).toHaveLength(1);
    expect(db.tables.onboarding_states[0]).toMatchObject({ import_job_id: db.tables.import_jobs[0].id });
  });

  it("keeps an unpaid Marketplace property parked even when nothing was purged", async () => {
    const db = property({ claimed: true, purged: false });
    await callback();
    expect(db.tables.pms_connections[0].status).toBe("pending");
    expect(db.tables.import_jobs).toEqual([]);
  });

  it("connects a hotel with no property on record yet, binds it to the one property the login reaches, with no import", async () => {
    const db = property({ claimed: false, purged: false, isActive: true, inApp: true });
    await callback();
    expect(db.tables.pms_connections[0].status).toBe("connected");
    // A new grant: rate pushes held for a missing permission or a refused grant go out next tick.
    expect(db.tables.pms_connections[0].reauthorized_at).toBe(db.tables.pms_connections[0].updated_at);
    expect(db.tables.import_jobs).toEqual([]);
    // Bound now, so a later login for another property is refused (below).
    expect(storedSecret()).toMatchObject({ propertyId: "320691" });
  });

  it("leaves a hotel with no property on record unbound when the login is a group's, as the sync then says", async () => {
    state.properties = [
      { propertyId: "320690", name: "Sea View Annex" },
      { propertyId: "320691", name: "Sea View Inn" },
    ];
    const db = property({ claimed: false, purged: false, isActive: true, inApp: true });
    await callback();
    expect(db.tables.pms_connections[0].status).toBe("connected");
    expect(storedSecret()).not.toHaveProperty("propertyId");
  });

  it("stores the bound property ID, so a single-property login syncs the right property", async () => {
    property({ claimed: true, purged: true });
    await callback();
    expect(storedSecret()).toMatchObject({ accessToken: "cbat", propertyId: "320691" });
  });

  it("takes a group login, stores this property's ID, and imports it", async () => {
    state.properties = [
      { propertyId: "320690", name: "Sea View Annex" },
      { propertyId: "320691", name: "Sea View Inn" },
    ];
    const db = property({ claimed: true, purged: true });
    const res = await callback();
    expect(res.status).toBe(302);
    expect(storedSecret()).toMatchObject({ propertyId: "320691" });
    expect(db.tables.import_jobs).toHaveLength(1);
    expect(db.tables.pms_connections[0]).toMatchObject({ status: "pending" });
  });

  it("says Cloudbeds didn't answer, not \"different property\", when the property list call fails", async () => {
    state.listFails = true;
    const db = property({ claimed: true, purged: true });
    const res = await callback();
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("Cloudbeds didn't answer");
    expect(text).not.toContain("different property");
    expect(storedSecret()).toBeUndefined();
    expect(db.tables.import_jobs).toEqual([]);
  });

  it("stores nothing when the claim can't be read, rather than treating the property as unbound", async () => {
    state.claimsReadFails = true;
    const db = property({ claimed: true, purged: true });
    const res = await callback();
    expect(res.status).toBe(400);
    expect(storedSecret()).toBeUndefined();
    expect(db.tables.pms_connections).toEqual([]);
    expect(db.tables.import_jobs).toEqual([]);
  });

  it("refuses a login for a different property: no credential, no connection, no import", async () => {
    state.properties = [{ propertyId: "999999", name: "Somewhere Else" }];
    const db = property({ claimed: true, purged: true, isActive: true, subscription: "active" });
    const res = await callback();
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("This login is for a different property.");
    expect(storedSecret()).toBeUndefined();
    expect(db.tables.pms_connections).toEqual([]);
    expect(db.tables.import_jobs).toEqual([]);
  });
});

describe("reconnecting a Cloudbeds property connected from inside MAYA", () => {
  // Its Cloudbeds property ID is kept with its credential, not on the hotel
  // row. The reconnect used to take any login, and a login for another
  // property moved the hotel onto it.
  const oldConnection = () => ({ hotel_id: "hotel-1", pms_type: "cloudbeds", status: "disconnected" });

  it("stops a login for a different property before anything is overwritten", async () => {
    state.storedProperty = "320691";
    state.properties = [{ propertyId: "999999", name: "Somewhere Else" }];
    const db = property({ claimed: false, purged: false, isActive: true, inApp: true, connection: "disconnected" });
    const res = await callback();
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("This login is for a different property.");
    expect(text).not.toContain("Command Center");
    expect(storedSecret()).toBeUndefined();
    expect(db.tables.pms_connections).toEqual([expect.objectContaining(oldConnection())]);
    expect(db.tables.pms_connections[0]).not.toHaveProperty("reauthorized_at");
    expect(db.tables.import_jobs).toEqual([]);
  });

  it("takes a login that reaches the property, a group one included, and keeps its property ID", async () => {
    state.storedProperty = "320691";
    state.properties = [
      { propertyId: "320690", name: "Sea View Annex" },
      { propertyId: "320691", name: "Sea View Inn" },
    ];
    const db = property({ claimed: false, purged: false, isActive: true, inApp: true, connection: "disconnected" });
    const res = await callback();
    expect(res.status).toBe(302);
    expect(storedSecret()).toMatchObject({ accessToken: "cbat", propertyId: "320691" });
    expect(db.tables.pms_connections[0].status).toBe("connected");
  });

  it("stores nothing when the current credential can't be read", async () => {
    state.secretReadFails = true;
    const db = property({ claimed: false, purged: false, isActive: true, inApp: true, connection: "disconnected" });
    const res = await callback();
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("We couldn't check this login just now. Try connecting again in a moment.");
    expect(storedSecret()).toBeUndefined();
    expect(db.tables.pms_connections).toEqual([expect.objectContaining(oldConnection())]);
  });

  it("says Cloudbeds didn't answer when the property list call fails", async () => {
    state.storedProperty = "320691";
    state.listFails = true;
    property({ claimed: false, purged: false, isActive: true, inApp: true, connection: "disconnected" });
    const res = await callback();
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Cloudbeds didn't answer");
    expect(storedSecret()).toBeUndefined();
  });
});

describe("where a successful reconnect lands", () => {
  // It used to be the staff console's page for the hotel, with no word that
  // anything had worked.
  it("opens the dashboard's PMS tab on that property with a short Reconnected note", async () => {
    property({ claimed: false, purged: false, isActive: true, inApp: true, connection: "disconnected" });
    const res = await callback();
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toBe("https://app.example/?tab=pms&dl=pms&note=reconnected");
    expect(location).not.toContain("/admin");
    expect(res.headers.get("set-cookie")).toContain("maya_active_hotel=hotel-1");

    // What the dashboard reads on arrival, and the line it shows.
    const arrival = links.readArrival(new URL(location).search);
    expect(arrival).toMatchObject({ dest: "pms", note: "reconnected", keep: "tab=pms" });
    expect(NOTE_TEXT[arrival.note!]).toBe("Reconnected.");
  });

  it("sends a reconnect started in the staff console back there", async () => {
    state.from = "admin";
    property({ claimed: false, purged: false, isActive: true, inApp: true, connection: "disconnected" });
    const res = await callback();
    expect(res.headers.get("location")).toBe("https://app.example/admin/hotels/hotel-1?pmsConnected=1");
  });

  it("sends a parked Marketplace property back to its payment screen", async () => {
    property({ claimed: true, purged: false });
    const res = await callback();
    expect(res.headers.get("location")).toBe("https://app.example/onboarding");
  });
});

describe("a reconnect MAYA staff started in God Mode", () => {
  it("does nothing once their window has ended: no grant spent, no credential, no connection", async () => {
    state.support = true;
    state.from = "admin";
    state.stillAllowed = false;
    const db = property({ claimed: false, purged: false, isActive: true, inApp: true, connection: "disconnected" });
    const res = await callback();
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("God Mode ended before the sign-in finished");
    expect(state.ssrRpcs).toEqual(["can_manage_finances"]);
    expect(fetch).not.toHaveBeenCalled();
    expect(storedSecret()).toBeUndefined();
    expect(db.tables.pms_connections[0]).toMatchObject({ status: "disconnected" });
  });

  it("reconnects while the window is still open", async () => {
    state.support = true;
    state.from = "admin";
    property({ claimed: false, purged: false, isActive: true, inApp: true, connection: "disconnected" });
    const res = await callback();
    expect(res.headers.get("location")).toBe("https://app.example/admin/hotels/hotel-1?pmsConnected=1");
    expect(state.ssrRpcs).toEqual(["can_manage_finances"]);
    expect(storedSecret()).toBeDefined();
  });

  it("asks the same of a member's reconnect: still signed in, still allowed", async () => {
    property({ claimed: false, purged: false, isActive: true, inApp: true, connection: "disconnected" });
    await callback();
    expect(state.ssrRpcs).toEqual(["can_manage_finances"]);
  });
});

describe("the reconnect link is the person's who started it", () => {
  // A signed link is good for 15 minutes wherever the browser is sent. Without
  // the person in it, anyone with a MAYA login and a property with no Cloudbeds
  // property on record could start a connect and hand the link to a manager
  // at another hotel to approve, and that hotel's login was stored under the
  // other property, read every 5 minutes and, once live, sent prices.
  const live = () => property({ claimed: false, purged: false, isActive: true, inApp: true, connection: "disconnected" });
  const nothingStored = (db: ReturnType<typeof property>) => {
    expect(fetch).not.toHaveBeenCalled();
    expect(storedSecret()).toBeUndefined();
    expect(db.tables.pms_connections[0]).toMatchObject({ status: "disconnected" });
    expect(db.tables.pms_connections[0]).not.toHaveProperty("reauthorized_at");
    expect(db.tables.import_jobs).toEqual([]);
  };

  it("finishes only for the account that started it: another account is refused before the grant is spent", async () => {
    state.browserUserId = "user-2";
    const db = live();
    const res = await callback();
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).toContain("started from a different account");
    expect(text).not.toContain("—");
    // Not even asked: the account is wrong before rights come into it.
    expect(state.ssrRpcs).toEqual([]);
    nothingStored(db);
  });

  it("refuses a signed-out browser the same way", async () => {
    state.browserUserId = null;
    const db = live();
    const res = await callback();
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("Sign in as the person who started it");
    nothingStored(db);
  });

  it("refuses the person who started it once they may no longer reconnect the property", async () => {
    state.stillAllowed = false;
    const db = live();
    const res = await callback();
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("Reconnecting needs General Manager access or higher on this property.");
    expect(state.ssrRpcs).toEqual(["can_manage_finances"]);
    nothingStored(db);
  });

  it("finishes for the person who started it, still allowed", async () => {
    const db = live();
    const res = await callback();
    expect(res.status).toBe(302);
    expect(storedSecret()).toMatchObject({ accessToken: "cbat" });
    expect(db.tables.pms_connections[0].status).toBe("connected");
  });
});

describe("a login for a property that is already another MAYA hotel's", () => {
  // The hotel has no Cloudbeds property on record (checkout's placeholder is
  // enough), so any login used to be taken and stored under it.
  const unbound = () => property({ claimed: false, purged: false, isActive: true, inApp: true, connection: "disconnected" });
  /** The admin log line that names the hotel in the way, which the person is not told. */
  const blockingLine = (errors: ReturnType<typeof vi.spyOn>) => {
    const lines = errors.mock.calls.map((c) => {
      try {
        return JSON.parse(String(c[0])) as Record<string, unknown>;
      } catch {
        return {};
      }
    });
    return lines.find((l) => l.step === "property_elsewhere" && l.refused === true);
  };
  const refused = async (db: ReturnType<typeof property>, blocking: Record<string, unknown>) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await callback();
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("already connected to another property in MAYA");
    expect(text).not.toContain("Command Center");
    expect(text).not.toContain(String(blocking.blockingHotelName));
    expect(storedSecret()).toBeUndefined();
    expect(db.tables.pms_connections[0]).toMatchObject({ status: "disconnected" });
    expect(db.tables.import_jobs).toEqual([]);
    // Support can see which hotel holds the property, and how.
    expect(blockingLine(errors)).toMatchObject({ fn: "handleOAuthCallback", hotelId: "hotel-1", ...blocking });
    errors.mockRestore();
  };

  it("is refused when a Marketplace hotel with a member already is that property", async () => {
    state.otherHotels = [{ id: "hotel-2", name: "Pilot Hotel", external_enterprise_id: "cloudbeds:320691", is_active: true, setup_pending_at: null }];
    state.otherMemberships = [{ hotel_id: "hotel-2", user_id: "user-9", status: "active" }];
    await refused(unbound(), { propertyId: "320691", blockingHotelId: "hotel-2", blockingHotelName: "Pilot Hotel", blockingVia: "marketplace", blockingConnectionStatus: null });
  });

  it("is refused when a hotel connected from inside MAYA keeps that property with its credential", async () => {
    state.otherHotels = [{ id: "hotel-2", name: "Pilot Hotel", external_enterprise_id: null, is_active: true, setup_pending_at: null }];
    state.otherConnections = [{ hotel_id: "hotel-2", pms_type: "cloudbeds", status: "connected", updated_at: "2026-09-01T00:00:00.000Z" }];
    state.otherStoredProperties = { "hotel-2": "320691" };
    await refused(unbound(), { propertyId: "320691", blockingHotelId: "hotel-2", blockingHotelName: "Pilot Hotel", blockingVia: "credential", blockingConnectionStatus: "connected" });
  });

  it("is refused over a hotel that has since been disconnected too, since it can reconnect by that property, and the log says which and in what state", async () => {
    // An abandoned or test hotel that once connected this property from
    // inside MAYA. Its credential is kept (a reconnect needs it), so it holds
    // the property; letting a second hotel in would leave both able to read
    // and price it. The way through is to clear that hotel, and the log names it.
    state.otherHotels = [{ id: "hotel-2", name: "Old test hotel", external_enterprise_id: null, is_active: true, setup_pending_at: null }];
    state.otherConnections = [{ hotel_id: "hotel-2", pms_type: "cloudbeds", status: "disconnected", updated_at: "2026-06-01T00:00:00.000Z" }];
    state.otherStoredProperties = { "hotel-2": "320691" };
    await refused(unbound(), { propertyId: "320691", blockingHotelId: "hotel-2", blockingHotelName: "Old test hotel", blockingVia: "credential", blockingConnectionStatus: "disconnected" });
  });

  it("is refused when any property of a group login is another hotel's", async () => {
    state.properties = [
      { propertyId: "320690", name: "Sea View Annex" },
      { propertyId: "320691", name: "Sea View Inn" },
    ];
    state.otherHotels = [{ id: "hotel-2", name: "Annex in MAYA", external_enterprise_id: "cloudbeds:320690", is_active: true, setup_pending_at: null }];
    state.otherMemberships = [{ hotel_id: "hotel-2", user_id: "user-9", status: "active" }];
    await refused(unbound(), { propertyId: "320690", blockingHotelId: "hotel-2", blockingHotelName: "Annex in MAYA", blockingVia: "marketplace" });
  });

  it("is not refused over an unclaimed Marketplace row, which is nobody's yet", async () => {
    state.otherHotels = [{ id: "hotel-2", name: "Sea View Inn (parked)", external_enterprise_id: "cloudbeds:320691", is_active: false, setup_pending_at: "2026-09-01T00:00:00.000Z" }];
    const db = unbound();
    const res = await callback();
    expect(res.status).toBe(302);
    expect(storedSecret()).toMatchObject({ propertyId: "320691" });
    expect(db.tables.pms_connections[0].status).toBe("connected");
  });

  it("stores nothing when the other hotels cannot be checked", async () => {
    state.otherHotels = [{ id: "hotel-2", name: "Other", external_enterprise_id: null, is_active: true, setup_pending_at: null }];
    state.otherConnections = [{ hotel_id: "hotel-2", pms_type: "cloudbeds", status: "connected", updated_at: "2026-09-01T00:00:00.000Z" }];
    state.secretReadFails = true;
    const db = unbound();
    const res = await callback();
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("We couldn't check this login just now.");
    expect(storedSecret()).toBeUndefined();
    expect(db.tables.pms_connections[0]).toMatchObject({ status: "disconnected" });
  });

  it("a hotel bound to its property is checked against the login as before, and its own property is no clash", async () => {
    state.storedProperty = "320691";
    state.otherHotels = [{ id: "hotel-2", name: "Other", external_enterprise_id: "cloudbeds:999999", is_active: true, setup_pending_at: null }];
    state.otherMemberships = [{ hotel_id: "hotel-2", user_id: "user-9", status: "active" }];
    const db = unbound();
    const res = await callback();
    expect(res.status).toBe(302);
    expect(db.tables.pms_connections[0].status).toBe("connected");
  });
});

describe("an import the lost connection stopped, after a reconnect from inside MAYA", () => {
  const job = (status: string, lastError: string | null) => ({
    id: "job-1",
    hotel_id: "hotel-1",
    pms_type: "cloudbeds",
    status,
    phase: "historical",
    last_error: lastError,
    finished_at: status === "running" ? null : "2026-09-20T10:00:00.000Z",
    stats: { errorStreak: 50, cursor: "2024-03" },
    created_at: "2026-09-19T10:00:00.000Z",
  });
  const live = (jobs: FakeRow[]) =>
    property({ claimed: false, purged: false, isActive: true, inApp: true, connection: "disconnected", jobs });

  it.each([
    ["canceled", "Stopped: the PMS connection was disconnected."],
    ["canceled", "Stopped: the property has no PMS connection."],
    ["failed", "Cloudbeds getReservations failed (401): Unauthorized"],
    ["failed", "cloudbeds refresh token was rejected (invalid_grant): reconnect via OAuth."],
    ["failed", "Cloudbeds getReservations failed (400): This application is not available to be connected"],
  ])("carries on a %s import (%s) from its checkpoint, with a fresh run of retries", async (status, why) => {
    const db = live([job(status, why)]);
    await callback();
    expect(db.tables.import_jobs).toHaveLength(1);
    expect(db.tables.import_jobs[0]).toMatchObject({
      id: "job-1",
      status: "queued",
      phase: "historical",
      finished_at: null,
      last_error: null,
      stats: { errorStreak: 0, cursor: "2024-03" },
    });
  });

  it.each([
    ["running", null],
    ["queued", null],
    ["completed", null],
    ["failed", "Cloudbeds getReservations failed (500): Internal Server Error"],
    ["canceled", 'Stopped: the owner chose "Not now" for this property.'],
  ])("leaves a %s import (%s) alone and starts no second one", async (status, why) => {
    const db = live([job(status, why)]);
    await callback();
    expect(db.tables.import_jobs).toEqual([expect.objectContaining({ id: "job-1", status, last_error: why })]);
  });

  it("leaves a parked property's stopped import for its payment screen", async () => {
    const db = property({
      claimed: true,
      purged: false,
      connection: "disconnected",
      jobs: [job("canceled", "Stopped: the PMS connection was disconnected.")],
    });
    await callback();
    expect(db.tables.pms_connections[0].status).toBe("pending");
    expect(db.tables.import_jobs).toEqual([expect.objectContaining({ id: "job-1", status: "canceled" })]);
  });
});
