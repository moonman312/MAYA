/**
 * Pins the two promises this route makes. It asks only when it is sure: a
 * missing table, a failed read, a signup whose tick the trigger missed, and MHS
 * staff all come back "not required", because the answer puts a screen in front
 * of the whole app. And what it writes is the server's account of the event:
 * the current versions, the observed address, no client timestamp, once.
 *
 * Same shape as ../../billing/portal/route.test.ts: an in-memory Supabase and
 * mocked clients, so the handlers run outside a request context.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRIVACY_VERSION, signupAcceptanceMetadata, TERMS_VERSION } from "@/lib/legal/versions";

type Row = Record<string, unknown>;
type DbError = { code?: string; message: string };

const USER = "user-1";

const state = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  user: null as null | { id: string; email?: string; user_metadata?: Record<string, unknown> },
  platformAdmin: false,
  adminConfigured: true,
  hotelId: null as string | null,
  readError: null as null | { code?: string; message: string },
  insertError: null as null | { code?: string; message: string },
  rpcCalls: [] as Array<{ fn: string; args: Row }>,
  adoptResult: true,
}));

function fakeSupabase() {
  const rows = (t: string) => (state.tables[t] ??= []);
  function builder(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let pending: Row | null = null;
    const run = async (): Promise<{ data: Row[] | null; error: DbError | null }> => {
      if (pending) {
        if (state.insertError) return { data: null, error: state.insertError };
        rows(table).push({ id: `row-${rows(table).length}`, ...pending });
        return { data: null, error: null };
      }
      if (state.readError) return { data: null, error: state.readError };
      return { data: rows(table).filter((r) => filters.every((f) => f(r))), error: null };
    };
    const api = {
      select: () => api,
      eq(col: string, val: unknown) {
        filters.push((r) => r[col] === val);
        return api;
      },
      is(col: string, val: unknown) {
        filters.push((r) => (r[col] ?? null) === val);
        return api;
      },
      limit: () => api,
      insert(payload: Row) {
        pending = payload;
        return api;
      },
      then(resolve: (v: unknown) => void, reject?: (e: unknown) => void) {
        return run().then(resolve, reject);
      },
    };
    return api;
  }
  return {
    from: (t: string) => builder(t),
    rpc: async (fn: string, args: Row) => {
      state.rpcCalls.push({ fn, args });
      if (fn === "is_platform_admin") return { data: state.platformAdmin, error: null };
      if (fn === "record_terms_acceptance_from_signup") {
        if (state.adoptResult) {
          rows("terms_acceptances").push({
            user_id: args.p_user_id,
            terms_version: TERMS_VERSION,
            privacy_version: PRIVACY_VERSION,
            context: "signup",
            source: "signup_metadata",
          });
        }
        return { data: state.adoptResult, error: null };
      }
      return { data: null, error: { message: `unexpected rpc ${fn}` } };
    },
    auth: { getUser: async () => ({ data: { user: state.user } }) },
  };
}

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/server", () => ({ createClient: () => fakeSupabase() }));
vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => fakeSupabase(),
  isAdminConfigured: () => state.adminConfigured,
}));
vi.mock("@/lib/hotel-context", () => ({ resolveAccessibleHotelId: async () => state.hotelId }));

const { GET, POST } = await import("./route");

const accepted = (extra: Row = {}): Row => ({
  user_id: USER,
  terms_version: TERMS_VERSION,
  privacy_version: PRIVACY_VERSION,
  context: "signup",
  hotel_id: null,
  ...extra,
});

function postBody(body: Row, headers: Record<string, string> = {}) {
  return new Request("https://app.example.com/api/legal/acceptance", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const valid = {
  accepted: true,
  context: "reaccept",
  termsVersion: TERMS_VERSION,
  privacyVersion: PRIVACY_VERSION,
};

async function required() {
  const res = await GET();
  expect(res.status).toBe(200);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  return ((await res.json()) as { required: boolean }).required;
}

beforeEach(() => {
  state.tables = {};
  state.user = { id: USER, email: "gm@driftwood.example", user_metadata: {} };
  state.platformAdmin = false;
  state.adminConfigured = true;
  state.hotelId = null;
  state.readError = null;
  state.insertError = null;
  state.rpcCalls = [];
  state.adoptResult = true;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET: does this person still have to accept?", () => {
  it("never asks someone who is not signed in", async () => {
    state.user = null;
    expect(await required()).toBe(false);
  });

  it("does not ask again once the current versions are on file", async () => {
    state.tables.terms_acceptances = [accepted()];
    expect(await required()).toBe(false);
  });

  it("asks when only an older version was accepted", async () => {
    state.tables.terms_acceptances = [accepted({ terms_version: "0" })];
    expect(await required()).toBe(true);
  });

  it("lets everyone through, loudly, while the migration has not run", async () => {
    state.readError = {
      code: "PGRST205",
      message: "Could not find the table 'public.terms_acceptances' in the schema cache",
    };
    expect(await required()).toBe(false);
    expect(String(vi.mocked(console.error).mock.calls[0]?.[0])).toContain(
      "99_supabase_migration_terms_acceptance_v1.sql",
    );
  });

  it("lets everyone through when the read fails for any other reason", async () => {
    state.readError = { message: "connection reset" };
    expect(await required()).toBe(false);
  });

  it("adopts a signup tick the trigger missed instead of asking twice", async () => {
    state.user = { id: USER, user_metadata: signupAcceptanceMetadata("claim") };
    expect(await required()).toBe(false);
    expect(state.rpcCalls).toContainEqual({
      fn: "record_terms_acceptance_from_signup",
      args: { p_user_id: USER },
    });
  });

  it("asks when the signup tick was for older wording", async () => {
    state.user = {
      id: USER,
      user_metadata: { maya_terms: { terms_version: "0", privacy_version: "0" } },
    };
    expect(await required()).toBe(true);
    expect(state.rpcCalls.map((c) => c.fn)).not.toContain("record_terms_acceptance_from_signup");
  });

  it("asks when the signup tick could not be adopted", async () => {
    state.user = { id: USER, user_metadata: signupAcceptanceMetadata("signup") };
    state.adoptResult = false;
    expect(await required()).toBe(true);
  });

  it("never asks MHS staff", async () => {
    state.platformAdmin = true;
    expect(await required()).toBe(false);
  });
});

describe("POST: recording an acceptance", () => {
  it("refuses someone who is not signed in", async () => {
    state.user = null;
    expect((await POST(postBody(valid))).status).toBe(401);
  });

  it("records nothing without an explicit tick", async () => {
    const res = await POST(postBody({ ...valid, accepted: "yes" }));
    expect(res.status).toBe(400);
    expect(state.tables.terms_acceptances ?? []).toHaveLength(0);
  });

  it("leaves signup and claim to the metadata trigger", async () => {
    for (const context of ["signup", "claim", "anything"]) {
      expect((await POST(postBody({ ...valid, context }))).status).toBe(400);
    }
    expect(state.tables.terms_acceptances ?? []).toHaveLength(0);
  });

  it("refuses to record a version the page did not show", async () => {
    const res = await POST(postBody({ ...valid, termsVersion: "0" }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { reason: string }).reason).toBe("stale_version");
    expect(state.tables.terms_acceptances ?? []).toHaveLength(0);
  });

  it("writes the server's account of it: versions, address, agent, property, and no client time", async () => {
    state.hotelId = "hotel-a";
    const res = await POST(
      postBody(
        { ...valid, context: "invite", acceptedAt: "1999-01-01T00:00:00Z" },
        {
          "x-real-ip": "203.0.113.7",
          "x-forwarded-for": "198.51.100.1, 10.0.0.1",
          "user-agent": "Mozilla/5.0 (Macintosh)",
        },
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, recorded: true });
    const rows = state.tables.terms_acceptances;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: USER,
      email: "gm@driftwood.example",
      terms_version: TERMS_VERSION,
      privacy_version: PRIVACY_VERSION,
      context: "invite",
      hotel_id: "hotel-a",
      ip: "203.0.113.7",
      user_agent: "Mozilla/5.0 (Macintosh)",
      source: "app",
    });
    // accepted_at is the database default; nothing the browser sent may set it.
    expect(rows[0]).not.toHaveProperty("accepted_at");
  });

  it("falls back to the first forwarded address", async () => {
    await POST(postBody(valid, { "x-forwarded-for": "198.51.100.1, 10.0.0.1" }));
    expect(state.tables.terms_acceptances[0].ip).toBe("198.51.100.1");
  });

  it("writes one row however many times the same acceptance arrives", async () => {
    await POST(postBody(valid));
    await POST(postBody(valid));
    expect(state.tables.terms_acceptances).toHaveLength(1);
  });

  it("lets them through rather than trapping them when the migration has not run", async () => {
    state.readError = { code: "42P01", message: 'relation "terms_acceptances" does not exist' };
    const res = await POST(postBody(valid));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, recorded: false });
  });

  it("asks them to try again when the write genuinely fails", async () => {
    state.insertError = { message: "connection reset" };
    expect((await POST(postBody(valid))).status).toBe(503);
  });
});
