/**
 * Regression tests for recording the "hold my hand / let me drive" choice.
 *
 * The choice now lands AFTER the PMS is connected, which changes what it means:
 * "let me drive" used to skip the connect step and drop people on an empty
 * dashboard, and now it leaves a running import alone and stops the dashboard
 * bouncing them back here. Both halves are written — the profile is what routing
 * reads, the property's own row is what the guided surfaces read — and the second
 * one failing must not lose the choice.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const USER = "user-1";

function fakeSupabase() {
  const tables = new Map<string, Row[]>();
  const failUpsertFor = new Set<string>();
  const tableOf = (name: string) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  };

  function builder(table: string) {
    const api = {
      select: () => api,
      eq: () => api,
      upsert(row: Row) {
        if (failUpsertFor.has(table)) {
          return Promise.resolve({ error: { message: `upsert into ${table} rejected` } });
        }
        const key = table === "profiles" ? "id" : "hotel_id";
        const found = tableOf(table).find((r) => r[key] === row[key]);
        if (found) Object.assign(found, row);
        else tableOf(table).push({ ...row });
        return Promise.resolve({ error: null });
      },
    };
    return api;
  }

  const client = {
    from: (t: string) => builder(t),
    auth: { getUser: async () => ({ data: { user: { id: USER } } }) },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, tables, failUpsertFor };
}

const state = vi.hoisted(() => ({ client: null as unknown, hotelId: "hotel-1" as string | null }));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/server", () => ({ createClient: () => state.client }));
vi.mock("@/lib/hotel-context", () => ({
  resolveAccessibleHotelId: async () => state.hotelId,
  MAYA_ACTIVE_HOTEL_COOKIE: "maya_active_hotel",
}));

const { POST } = await import("./route");

function post(body: unknown) {
  return POST(
    new Request("http://localhost/api/onboarding/path", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function seed() {
  const fake = fakeSupabase();
  state.client = fake.client;
  return fake;
}

beforeEach(() => {
  state.hotelId = "hotel-1";
});

describe("recording the choice", () => {
  it("stamps let-me-drive on both the profile and the property", async () => {
    const { tables } = seed();
    const res = await post({ path: "self_serve" });
    expect(res.status).toBe(200);

    const profile = tables.get("profiles")?.[0];
    expect(profile).toMatchObject({ id: USER, onboarding_path: "self_serve" });
    // What stops the dashboard sending them straight back here.
    expect(profile?.onboarding_dismissed_at).toBeTruthy();

    expect(tables.get("onboarding_states")?.[0]).toMatchObject({
      hotel_id: "hotel-1",
      path: "self_serve",
    });
  });

  it("leaves hold-my-hand undismissed, so the guided steps still run", async () => {
    const { tables } = seed();
    const res = await post({ path: "guided" });
    expect(res.status).toBe(200);
    expect(tables.get("profiles")?.[0]).toMatchObject({
      onboarding_path: "guided",
      onboarding_dismissed_at: null,
    });
    expect(tables.get("onboarding_states")?.[0]).toMatchObject({ path: "guided" });
  });

  it("keeps the choice when the property's own row cannot be written", async () => {
    const { tables, failUpsertFor } = seed();
    failUpsertFor.add("onboarding_states");
    const res = await post({ path: "self_serve" });
    expect(res.status).toBe(200);
    expect(tables.get("profiles")?.[0]).toMatchObject({ onboarding_path: "self_serve" });
  });

  it("records the profile even with no property to record it against", async () => {
    const { tables } = seed();
    state.hotelId = null;
    const res = await post({ path: "self_serve" });
    expect(res.status).toBe(200);
    expect(tables.get("profiles")?.[0]).toMatchObject({ onboarding_path: "self_serve" });
    expect(tables.get("onboarding_states") ?? []).toHaveLength(0);
  });

  it("rejects anything that isn't one of the two buttons", async () => {
    const { tables } = seed();
    const res = await post({ path: "whatever" });
    expect(res.status).toBe(400);
    expect(tables.get("profiles") ?? []).toHaveLength(0);
  });
});
