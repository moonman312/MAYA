/**
 * The way back for a never-paid property the retention sweep emptied. The
 * sweep leaves the property, its owner and rules, and deletes the connection,
 * the credential, the import jobs and the history, stamping data_purged_at. So
 * what has to hold: that shape reads as "reconnect needed", and a reconnect
 * queues a fresh full import whether or not the owner has paid by then, while
 * a property that was never purged gets no second import.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { callTouchesColumn, fakeSupabase, missingColumn, type FakeFault, type FakeRow } from "../engine/fake-supabase.test";

vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: () => null }));

import { marketplaceReconnectNeeded, queueImportAfterPurge, readDataPurgedAt } from "./purged";

const OWNER = "user-owner";
const PURGED_AT = "2027-03-01T00:00:00.000Z";

function purgedProperty(opts: {
  isActive?: boolean;
  purgedAt?: string | null;
  connection?: string | null;
  deferred?: boolean;
  subscription?: string;
  jobs?: FakeRow[];
  onboarding?: FakeRow | null;
  fault?: FakeFault;
} = {}) {
  return fakeSupabase(
    {
      hotels: [
        {
          id: "hotel-1",
          name: "Sea View Inn",
          is_active: opts.isActive ?? false,
          setup_pending_at: opts.isActive ? null : "2026-09-01T00:00:00.000Z",
          setup_deferred_at: opts.deferred ? "2026-09-02T00:00:00.000Z" : null,
          data_purged_at: opts.purgedAt === undefined ? PURGED_AT : opts.purgedAt,
          created_at: "2026-09-01T00:00:00.000Z",
        },
      ],
      pms_marketplace_claims: [
        {
          token: "tok",
          hotel_id: "hotel-1",
          pms_type: "cloudbeds",
          claimed_by: OWNER,
          claimed_at: "2026-09-01T00:00:00.000Z",
        },
      ],
      hotel_memberships: [{ hotel_id: "hotel-1", user_id: OWNER, status: "active" }],
      pms_connections:
        opts.connection === null || opts.connection === undefined
          ? []
          : [{ hotel_id: "hotel-1", pms_type: "cloudbeds", status: opts.connection }],
      hotel_subscriptions: opts.subscription ? [{ hotel_id: "hotel-1", status: opts.subscription }] : [],
      import_jobs: opts.jobs ?? [],
      onboarding_states: opts.onboarding ? [opts.onboarding] : [],
    },
    { fault: opts.fault },
  );
}

const noPurgeColumn: FakeFault = (call) =>
  call.table === "hotels" && callTouchesColumn(call, "data_purged_at") ? missingColumn("hotels", "data_purged_at") : null;

beforeEach(() => {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
});

describe("readDataPurgedAt", () => {
  it("reads the stamp", async () => {
    const db = purgedProperty();
    expect(await readDataPurgedAt(db.client, "hotel-1")).toBe(PURGED_AT);
  });

  it("reads a missing column as never purged, since the sweep arrives with it", async () => {
    const db = purgedProperty({ fault: noPurgeColumn });
    expect(await readDataPurgedAt(db.client, "hotel-1")).toBeNull();
  });
});

describe("marketplaceReconnectNeeded", () => {
  it("asks for a reconnect when the sweep left no connection, and says the history went", async () => {
    const db = purgedProperty();
    expect(await marketplaceReconnectNeeded(db.client, "hotel-1")).toEqual({
      pmsType: "cloudbeds",
      historyRemoved: true,
    });
  });

  it("does not claim the history went when nothing was purged", async () => {
    const db = purgedProperty({ purgedAt: null });
    expect(await marketplaceReconnectNeeded(db.client, "hotel-1")).toEqual({
      pmsType: "cloudbeds",
      historyRemoved: false,
    });
  });

  it("still works before the column exists", async () => {
    const db = purgedProperty({ fault: noPurgeColumn });
    expect(await marketplaceReconnectNeeded(db.client, "hotel-1")).toEqual({
      pmsType: "cloudbeds",
      historyRemoved: false,
    });
  });

  it("leaves a property that still has a connection row to the ordinary prompt", async () => {
    const db = purgedProperty({ connection: "disconnected" });
    expect(await marketplaceReconnectNeeded(db.client, "hotel-1")).toBeNull();
  });

  it("is not about hotels that never came from the Marketplace", async () => {
    const db = purgedProperty();
    db.tables.pms_marketplace_claims = [];
    expect(await marketplaceReconnectNeeded(db.client, "hotel-1")).toBeNull();
  });
});

describe("queueImportAfterPurge", () => {
  it("does nothing for a property that was never purged: a reconnect is not a re-import", async () => {
    const db = purgedProperty({ purgedAt: null, connection: "pending" });
    expect(await queueImportAfterPurge(db.client, "hotel-1", "cloudbeds", null)).toEqual({
      queued: false,
      reason: "not_purged",
    });
    expect(db.tables.import_jobs).toEqual([]);
  });

  it("does nothing before the column exists", async () => {
    const db = purgedProperty({ connection: "pending", fault: noPurgeColumn });
    expect(await queueImportAfterPurge(db.client, "hotel-1", "cloudbeds", null)).toMatchObject({
      queued: false,
      reason: "not_purged",
    });
    expect(db.tables.import_jobs).toEqual([]);
  });

  it("queues a fresh full import for a parked property, under the owner who claimed it", async () => {
    const db = purgedProperty({ connection: "pending" });
    const r = await queueImportAfterPurge(db.client, "hotel-1", "cloudbeds", null);
    expect(r).toMatchObject({ queued: true });
    expect(db.tables.import_jobs).toHaveLength(1);
    expect(db.tables.import_jobs[0]).toMatchObject({
      hotel_id: "hotel-1",
      status: "queued",
      phase: "discover",
      requested_by: OWNER,
    });
    // Parked stays parked: nothing about this makes it live.
    expect(db.tables.hotels[0].is_active).toBe(false);
    expect(db.tables.pms_connections[0].status).toBe("pending");
  });

  it("respects Not now on a parked property", async () => {
    const db = purgedProperty({ connection: "pending", deferred: true });
    // Out of the subscribe screen's queue, so never next in line.
    expect(await queueImportAfterPurge(db.client, "hotel-1", "cloudbeds", OWNER)).toMatchObject({
      queued: false,
      reason: "not_next",
    });
    expect(db.tables.import_jobs).toEqual([]);
  });

  it("queues only the sibling the subscribe screen shows next, not the whole group", async () => {
    const db = purgedProperty({ connection: "pending" });
    db.tables.hotels.push({
      ...db.tables.hotels[0],
      id: "hotel-2",
      name: "Sea View Annex",
      created_at: "2026-09-01T00:00:01.000Z",
    });
    db.tables.pms_marketplace_claims.push({ ...db.tables.pms_marketplace_claims[0], token: "tok2", hotel_id: "hotel-2" });
    db.tables.hotel_memberships.push({ hotel_id: "hotel-2", user_id: OWNER, status: "active" });
    db.tables.pms_connections.push({ hotel_id: "hotel-2", pms_type: "cloudbeds", status: "pending" });

    expect(await queueImportAfterPurge(db.client, "hotel-2", "cloudbeds", null)).toEqual({
      queued: false,
      reason: "not_next",
    });
    expect(await queueImportAfterPurge(db.client, "hotel-1", "cloudbeds", null)).toMatchObject({ queued: true });
    expect(db.tables.import_jobs.map((j) => j.hotel_id)).toEqual(["hotel-1"]);
  });

  it("does not queue before the reconnect has written a connection", async () => {
    const db = purgedProperty({ isActive: true, subscription: "active" });
    expect(await queueImportAfterPurge(db.client, "hotel-1", "cloudbeds", OWNER)).toEqual({
      queued: false,
      reason: "no_connection",
    });
    expect(db.tables.import_jobs).toEqual([]);
  });

  it("leaves a trial that ended unpaid for payment, even though it is still is_active", async () => {
    const db = purgedProperty({ isActive: true, subscription: "canceled", connection: "pending" });
    expect(await queueImportAfterPurge(db.client, "hotel-1", "cloudbeds", OWNER)).toEqual({
      queued: false,
      reason: "not_next",
    });
    expect(db.tables.import_jobs).toEqual([]);
    expect(db.tables.onboarding_states).toEqual([]);
  });

  it("imports a live property again and points onboarding at the new job", async () => {
    const db = purgedProperty({
      isActive: true,
      subscription: "active",
      connection: "connected",
      onboarding: { hotel_id: "hotel-1", path: "guided", import_job_id: null, questions_completed_at: "x" },
    });
    const r = await queueImportAfterPurge(db.client, "hotel-1", "cloudbeds", OWNER);
    expect(r).toMatchObject({ queued: true });
    const job = db.tables.import_jobs[0];
    expect(job).toMatchObject({ status: "queued", phase: "discover" });
    expect(db.tables.onboarding_states).toEqual([
      { hotel_id: "hotel-1", path: "guided", import_job_id: job.id, questions_completed_at: "x" },
    ]);
  });

  it("re-queues the job a payment made before the reconnect, which stopped with no connection", async () => {
    const stopped = {
      id: "job-9",
      hotel_id: "hotel-1",
      pms_type: "cloudbeds",
      status: "canceled",
      phase: "discover",
      last_error: "Stopped: the property has no PMS connection.",
      created_at: "2027-03-02T00:00:00.000Z",
      stats: {},
    };
    const db = purgedProperty({
      isActive: true,
      subscription: "trialing",
      connection: "connected",
      jobs: [stopped],
      onboarding: { hotel_id: "hotel-1", path: "guided", import_job_id: "job-9" },
    });
    expect(await queueImportAfterPurge(db.client, "hotel-1", "cloudbeds", OWNER)).toEqual({
      queued: true,
      jobId: "job-9",
    });
    expect(db.tables.import_jobs).toHaveLength(1);
    expect(db.tables.import_jobs[0]).toMatchObject({ status: "queued", last_error: null });
    expect(db.tables.onboarding_states[0].import_job_id).toBe("job-9");
  });
});
