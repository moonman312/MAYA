/**
 * The step that makes a Marketplace property live, which happens when its
 * subscription lands rather than when its owner claims it. The claim has
 * usually started the history import already, so the failure modes that
 * matter: activating Flow B's placeholder (a hotel with no PMS behind it),
 * queueing a second import beside the one the claim started, pulling a
 * finished import again from scratch, losing the job so the progress screen
 * waits forever, and a paywall check that says yes to a hotel with no
 * subscription at all.
 */
import { afterEach, describe, expect, it } from "vitest";
import { fakeSupabase, type FakeFault, type FakeRow } from "../engine/fake-supabase.test";
import {
  activateMarketplaceHotelIfPending,
  hasEntitledSubscription,
  marketplaceTrialDays,
} from "./marketplace-activate";

const HOTEL = "hotel-mkt";

function claimed(extra: Record<string, FakeRow[]> = {}, fault?: FakeFault) {
  const rpcs: string[] = [];
  const db = fakeSupabase(
    {
      hotels: [{ id: HOTEL, is_active: false, setup_pending_at: "2026-09-10T14:08:00Z" }],
      pms_connections: [{ hotel_id: HOTEL, pms_type: "cloudbeds", status: "pending" }],
      pms_marketplace_claims: [
        {
          token: "tok",
          hotel_id: HOTEL,
          pms_type: "cloudbeds",
          property_name: "Sea View Inn",
          claimed_by: "user-1",
          claimed_at: "2026-09-10T14:09:00Z",
        },
      ],
      hotel_subscriptions: [{ hotel_id: HOTEL, status: "trialing" }],
      ...extra,
    },
    {
      fault,
      rpc: (fn) => {
        rpcs.push(fn);
        return null;
      },
    },
  );
  return { ...db, rpcs };
}

/** An import the claim queued before anyone paid. */
function preJob(over: FakeRow = {}): FakeRow {
  return {
    id: "job-pre",
    hotel_id: HOTEL,
    pms_type: "cloudbeds",
    status: "queued",
    phase: "discover",
    requested_by: "user-1",
    created_at: "2026-09-10T14:09:01Z",
    stats: {},
    ...over,
  };
}

describe("activateMarketplaceHotelIfPending", () => {
  it("leaves Flow B's placeholder alone — there is no PMS behind it to import from", async () => {
    const db = fakeSupabase({
      hotels: [{ id: "hotel-pending", is_active: false, setup_pending_at: "2026-07-01T00:00:00Z" }],
    });
    const r = await activateMarketplaceHotelIfPending(db.client, "hotel-pending");
    expect(r).toEqual({ activated: false, reason: "not_marketplace" });
    expect(db.tables.hotels[0].is_active).toBe(false);
    expect(db.tables.import_jobs ?? []).toHaveLength(0);
  });

  it("makes a claimed property live and queues its import when the claim queued none", async () => {
    const db = claimed();
    const r = await activateMarketplaceHotelIfPending(db.client, HOTEL, { requestedBy: "user-1" });
    expect(r).toMatchObject({ activated: true, hotelId: HOTEL });

    expect(db.tables.hotels[0]).toMatchObject({ is_active: true, setup_pending_at: null });
    expect(db.tables.pms_connections[0]).toMatchObject({ status: "connected" });

    const jobs = db.tables.import_jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ hotel_id: HOTEL, pms_type: "cloudbeds", status: "queued", requested_by: "user-1" });
    expect(r).toMatchObject({ importJobId: jobs[0].id });

    expect(db.tables.onboarding_states[0]).toMatchObject({ hotel_id: HOTEL, path: "guided", import_job_id: jobs[0].id });
    expect(db.rpcs).toContain("platform_log_event");
  });

  it("runs the import exactly once when the webhook and the return route both arrive", async () => {
    const db = claimed();
    const first = await activateMarketplaceHotelIfPending(db.client, HOTEL);
    const second = await activateMarketplaceHotelIfPending(db.client, HOTEL);
    expect(first).toMatchObject({ activated: true });
    expect(second).toEqual({ activated: false, reason: "already_active" });
    expect(db.tables.import_jobs).toHaveLength(1);
  });

  it("falls back to the claim's owner when the caller has no user in hand", async () => {
    const db = claimed();
    await activateMarketplaceHotelIfPending(db.client, HOTEL);
    expect(db.tables.import_jobs[0]).toMatchObject({ requested_by: "user-1" });
  });

  it("accepts the claim being burned right now, whose claimed_at is not on disk yet", async () => {
    const db = claimed({
      pms_marketplace_claims: [{ token: "tok", hotel_id: HOTEL, pms_type: "cloudbeds", claimed_at: null, claimed_by: null }],
    });
    const r = await activateMarketplaceHotelIfPending(db.client, HOTEL, {
      claim: {
        token: "tok",
        hotel_id: HOTEL,
        pms_type: "cloudbeds",
        property_name: "Sea View Inn",
        claimed_by: "user-1",
        claimed_at: "2026-09-10T14:09:00Z",
      },
    });
    expect(r).toMatchObject({ activated: true });
  });

  it("releases a lapsed customer's parked connection when they pay again, and imports nothing", async () => {
    const db = claimed({
      hotels: [{ id: HOTEL, is_active: true, setup_pending_at: null }],
      hotel_subscriptions: [{ hotel_id: HOTEL, status: "active" }],
      import_jobs: [preJob({ id: "job-old", status: "completed", phase: "done" })],
      onboarding_states: [{ hotel_id: HOTEL, path: "guided", import_job_id: "job-old" }],
    });
    const r = await activateMarketplaceHotelIfPending(db.client, HOTEL);
    expect(r).toEqual({ activated: false, reason: "already_active" });
    expect(db.tables.pms_connections[0]).toMatchObject({ status: "connected" });
    expect(db.tables.import_jobs).toHaveLength(1);
    expect(db.tables.import_jobs[0].status).toBe("completed");
  });

  it("keeps a parked connection parked while nothing has been paid", async () => {
    const db = claimed({
      hotels: [{ id: HOTEL, is_active: true, setup_pending_at: null }],
      hotel_subscriptions: [{ hotel_id: HOTEL, status: "canceled" }],
    });
    await activateMarketplaceHotelIfPending(db.client, HOTEL);
    expect(db.tables.pms_connections[0]).toMatchObject({ status: "pending" });
    expect(db.tables.import_jobs ?? []).toHaveLength(0);
  });

  it("never reconnects a property that uninstalled, even once it has paid", async () => {
    const db = claimed({
      hotels: [{ id: HOTEL, is_active: true, setup_pending_at: null }],
      pms_connections: [{ hotel_id: HOTEL, pms_type: "cloudbeds", status: "disconnected" }],
      hotel_subscriptions: [{ hotel_id: HOTEL, status: "active" }],
      onboarding_states: [{ hotel_id: HOTEL, import_job_id: "job-old" }],
    });
    await activateMarketplaceHotelIfPending(db.client, HOTEL);
    expect(db.tables.pms_connections[0]).toMatchObject({ status: "disconnected" });
  });

  it("reports a property that does not exist rather than inventing one", async () => {
    const db = fakeSupabase({ pms_marketplace_claims: claimed().tables.pms_marketplace_claims });
    const r = await activateMarketplaceHotelIfPending(db.client, HOTEL);
    expect(r).toEqual({ activated: false, reason: "not_found" });
  });
});

describe("payment adopts the import the claim started", () => {
  it.each(["queued", "running"])("points at a %s pre-payment job instead of queueing a second", async (status) => {
    const db = claimed({ import_jobs: [preJob({ status, phase: "historical", window_index: 2 })] });

    const r = await activateMarketplaceHotelIfPending(db.client, HOTEL, { requestedBy: "user-1" });

    expect(r).toMatchObject({ activated: true, importJobId: "job-pre" });
    expect(db.tables.import_jobs).toHaveLength(1);
    expect(db.tables.import_jobs[0]).toMatchObject({ status, phase: "historical", window_index: 2 });
    expect(db.tables.onboarding_states[0]).toMatchObject({ import_job_id: "job-pre" });
    expect(db.calls.some((c) => c.table === "import_jobs" && c.op === "insert")).toBe(false);
  });

  it("points at a finished import and does not pull it again", async () => {
    const db = claimed({
      import_jobs: [preJob({ status: "completed", phase: "done", finished_at: "2026-09-10T14:20:00Z" })],
    });

    const r = await activateMarketplaceHotelIfPending(db.client, HOTEL);

    expect(r).toMatchObject({ activated: true, importJobId: "job-pre" });
    expect(db.tables.import_jobs).toHaveLength(1);
    expect(db.tables.import_jobs[0]).toMatchObject({ status: "completed", phase: "done" });
    expect(db.calls.some((c) => c.table === "import_jobs" && c.op === "update")).toBe(false);
  });

  it("re-queues a failed import from its checkpoint, with a fresh run of retries", async () => {
    const db = claimed({
      import_jobs: [
        preJob({
          status: "failed",
          phase: "historical",
          window_index: 4,
          last_error: "Cloudbeds 502",
          finished_at: "2026-09-11T00:00:00Z",
          stats: { errorStreak: 50, historyAnchor: "2026-08-11" },
        }),
      ],
    });

    const r = await activateMarketplaceHotelIfPending(db.client, HOTEL);

    expect(r).toMatchObject({ activated: true, importJobId: "job-pre" });
    expect(db.tables.import_jobs).toHaveLength(1);
    expect(db.tables.import_jobs[0]).toMatchObject({
      status: "queued",
      phase: "historical",
      window_index: 4,
      last_error: null,
      finished_at: null,
      stats: { errorStreak: 0, historyAnchor: "2026-08-11" },
    });
    expect(db.tables.onboarding_states[0]).toMatchObject({ import_job_id: "job-pre" });
  });

  it("re-queues an import that was stopped, rather than starting over", async () => {
    const db = claimed({
      import_jobs: [preJob({ status: "canceled", phase: "sync_current", last_error: "Stopped: the PMS connection was disconnected." })],
    });
    const r = await activateMarketplaceHotelIfPending(db.client, HOTEL);
    expect(r).toMatchObject({ activated: true, importJobId: "job-pre" });
    expect(db.tables.import_jobs).toHaveLength(1);
    expect(db.tables.import_jobs[0]).toMatchObject({ status: "queued", phase: "sync_current" });
  });

  it("adopts the job that won when the one-active-job index refuses the insert", async () => {
    let raced = false;
    const db = claimed({}, (call) => {
      if (!raced && call.table === "import_jobs" && call.op === "insert") {
        raced = true;
        db.tables.import_jobs.push(preJob({ id: "job-racer" }));
        return { code: "23505", message: 'duplicate key value violates unique constraint "uq_import_jobs_one_active_per_hotel"' };
      }
      return null;
    });

    const r = await activateMarketplaceHotelIfPending(db.client, HOTEL);

    expect(r).toMatchObject({ activated: true, importJobId: "job-racer" });
    expect(db.tables.import_jobs).toHaveLength(1);
    expect(db.tables.onboarding_states[0]).toMatchObject({ import_job_id: "job-racer" });
  });

  it("reports a refused insert with nothing to adopt as a failure, and writes no empty job pointer", async () => {
    const db = claimed({}, (call) =>
      call.table === "import_jobs" && call.op === "insert"
        ? { code: "23505", message: "duplicate key value violates unique constraint" }
        : null,
    );

    const r = await activateMarketplaceHotelIfPending(db.client, HOTEL);

    expect(r).toMatchObject({ activated: false, reason: "failed" });
    expect(db.tables.onboarding_states ?? []).toHaveLength(0);
  });

  it("finishes the adoption on the next arrival for a live property pointing at no job", async () => {
    const db = claimed({
      hotels: [{ id: HOTEL, is_active: true, setup_pending_at: null }],
      pms_connections: [{ hotel_id: HOTEL, pms_type: "cloudbeds", status: "connected" }],
      import_jobs: [preJob({ status: "running" })],
    });

    const r = await activateMarketplaceHotelIfPending(db.client, HOTEL);

    expect(r).toEqual({ activated: false, reason: "already_active" });
    expect(db.tables.import_jobs).toHaveLength(1);
    expect(db.tables.onboarding_states[0]).toMatchObject({ hotel_id: HOTEL, import_job_id: "job-pre" });
  });
});

describe("hasEntitledSubscription — the paywall check", () => {
  it("is false for a hotel with no subscription at all, unlike isHotelEntitled", async () => {
    expect(await hasEntitledSubscription(fakeSupabase().client, HOTEL)).toBe(false);
  });

  it("is false while the subscription is incomplete or dead", async () => {
    for (const status of ["incomplete", "incomplete_expired", "unpaid", "canceled"]) {
      const db = fakeSupabase({ hotel_subscriptions: [{ hotel_id: HOTEL, status }] });
      expect(await hasEntitledSubscription(db.client, HOTEL)).toBe(false);
    }
  });

  it("is true for trialing, active, and a card mid-retry", async () => {
    for (const status of ["trialing", "active", "past_due"]) {
      const db = fakeSupabase({ hotel_subscriptions: [{ hotel_id: HOTEL, status }] });
      expect(await hasEntitledSubscription(db.client, HOTEL)).toBe(true);
    }
  });
});

describe("marketplaceTrialDays", () => {
  const original = process.env.MAYA_MARKETPLACE_TRIAL_DAYS;
  afterEach(() => {
    if (original === undefined) delete process.env.MAYA_MARKETPLACE_TRIAL_DAYS;
    else process.env.MAYA_MARKETPLACE_TRIAL_DAYS = original;
  });

  it("is off when unset, and reads the number when set", () => {
    delete process.env.MAYA_MARKETPLACE_TRIAL_DAYS;
    expect(marketplaceTrialDays()).toBe(0);
    process.env.MAYA_MARKETPLACE_TRIAL_DAYS = "7";
    expect(marketplaceTrialDays()).toBe(7);
  });

  it("treats nonsense and negatives as off, and caps a year", () => {
    for (const v of ["abc", "-1", "0", "1.5", ""]) {
      process.env.MAYA_MARKETPLACE_TRIAL_DAYS = v;
      expect(marketplaceTrialDays()).toBe(0);
    }
    process.env.MAYA_MARKETPLACE_TRIAL_DAYS = "9999";
    expect(marketplaceTrialDays()).toBe(365);
  });
});
