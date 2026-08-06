/**
 * "Ask Maya for help" queues a full PMS re-import — the most expensive thing a
 * button in this app can do. The gates in front of it: manage rights, a paid-up
 * subscription (a hotel with no subscription row at all stays allowed — the
 * sandbox default), a per-hotel budget, and one active job at a time.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  userId: "user-1" as string | null,
  canManage: true,
  subscriptionStatus: null as string | null,
  pmsConnection: { pms_type: "cloudbeds", status: "connected" } as Row | null,
  activeJob: null as Row | null,
  limiter: { allowed: true, hits: 1, resets_at: "2026-07-31T01:00:00Z" },
  insertedJobs: [] as Row[],
  stateUpserts: [] as Row[],
}));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/lib/hotel-context", () => ({
  resolveAccessibleHotelId: async () => "hotel-1",
}));
vi.mock("@/utils/supabase/server", () => ({
  createClient: () => {
    const table = (name: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api: any = {
        select: () => api,
        eq: () => api,
        in: () => api,
        limit: () => api,
        maybeSingle: async () => ({
          data: name === "pms_connections" ? state.pmsConnection : null,
          error: null,
        }),
        then: (resolve: (v: { data: Row[]; error: null }) => void) =>
          Promise.resolve({
            data:
              name === "hotel_subscriptions" && state.subscriptionStatus
                ? [{ hotel_id: "hotel-1", status: state.subscriptionStatus }]
                : [],
            error: null,
          }).then(resolve),
      };
      return api;
    };
    return {
      auth: {
        getUser: async () => ({
          data: { user: state.userId ? { id: state.userId } : null },
        }),
      },
      rpc: async () => ({ data: state.canManage, error: null }),
      from: table,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  },
}));
vi.mock("@/utils/supabase/admin", () => ({
  isAdminConfigured: () => true,
  createAdminClient: () => ({
    rpc: () => ({ maybeSingle: async () => ({ data: state.limiter, error: null }) }),
    from: (name: string) => {
      if (name === "import_jobs") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const api: any = {
          select: () => api,
          eq: () => api,
          in: () => api,
          maybeSingle: async () => ({ data: state.activeJob, error: null }),
          insert: (row: Row) => {
            state.insertedJobs.push(row);
            return {
              select: () => ({
                single: async () => ({ data: { id: "job-9" }, error: null }),
              }),
            };
          },
        };
        return api;
      }
      return {
        upsert: (row: Row) => {
          state.stateUpserts.push(row);
          return Promise.resolve({ error: null });
        },
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any,
}));

const { POST } = await import("./route");

beforeEach(() => {
  state.userId = "user-1";
  state.canManage = true;
  state.subscriptionStatus = null;
  state.pmsConnection = { pms_type: "cloudbeds", status: "connected" };
  state.activeJob = null;
  state.limiter = { allowed: true, hits: 1, resets_at: "2026-07-31T01:00:00Z" };
  state.insertedJobs = [];
  state.stateUpserts = [];
  // Keep the worker nudge from reaching for a network in tests.
  delete process.env.ONBOARDING_CRON_SECRET;
});

describe("POST /api/onboarding/refresh", () => {
  it("401 when signed out", async () => {
    state.userId = null;
    expect((await POST()).status).toBe(401);
    expect(state.insertedJobs).toHaveLength(0);
  });

  it("403 without manage rights", async () => {
    state.canManage = false;
    expect((await POST()).status).toBe(403);
    expect(state.insertedJobs).toHaveLength(0);
  });

  it.each(["canceled", "unpaid"])(
    "402 for a %s subscription — a lapsed hotel doesn't get to re-pull its PMS",
    async (status) => {
      state.subscriptionStatus = status;
      expect((await POST()).status).toBe(402);
      expect(state.insertedJobs).toHaveLength(0);
    },
  );

  it("still runs for past_due — inside Stripe's retry window", async () => {
    state.subscriptionStatus = "past_due";
    expect((await POST()).status).toBe(200);
    expect(state.insertedJobs).toHaveLength(1);
  });

  it("429 once the hotel's budget is spent, and nothing is queued", async () => {
    state.limiter = { allowed: false, hits: 6, resets_at: "2026-07-31T01:00:00Z" };
    const res = await POST();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(state.insertedJobs).toHaveLength(0);
  });

  it("400 with nothing connected to re-pull from", async () => {
    state.pmsConnection = null;
    expect((await POST()).status).toBe(400);
    expect(state.insertedJobs).toHaveLength(0);
  });

  it("queues a refresh job and reopens the review", async () => {
    const res = await POST();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, jobId: "job-9" });
    expect(state.insertedJobs[0]).toMatchObject({
      hotel_id: "hotel-1",
      status: "queued",
      stats: { mode: "refresh" },
    });
    expect(state.stateUpserts[0]).toMatchObject({
      hotel_id: "hotel-1",
      import_job_id: "job-9",
      review_completed_at: null,
    });
  });

  it("answers with the running job instead of stacking a second one", async () => {
    state.activeJob = { id: "job-3" };
    const res = await POST();
    expect(await res.json()).toMatchObject({ ok: true, jobId: "job-3", alreadyRunning: true });
    expect(state.insertedJobs).toHaveLength(0);
  });
});
