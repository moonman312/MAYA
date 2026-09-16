/**
 * Importing at the claim, end to end over the real claim, queue and activation
 * code on an in-memory database. What has to hold: a claim queues exactly one
 * import, for the property the owner is about to see; a group's other
 * properties are imported one at a time as each comes up, and never one the
 * owner put off; nothing about the property goes live before payment; an
 * anonymous connect nobody claims is never read; and payment adopts the job
 * that is already there.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase, type FakeRow } from "../engine/fake-supabase.test";

const state = vi.hoisted(() => ({
  stripe: true,
  db: null as unknown as ReturnType<typeof import("../engine/fake-supabase.test").fakeSupabase>,
}));

vi.mock("@/lib/billing/stripe", () => ({ isStripeConfigured: () => state.stripe }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: () => state.db.client }));

import { listUnpaidMarketplaceHotels } from "@/lib/billing/pending-hotel";
import { redeemMarketplaceClaim } from "./marketplace-claim";
import { activateMarketplaceHotelIfPending } from "./marketplace-activate";
import { queuePrePaymentImport, resumeStoppedImport, stopPrePaymentImport } from "./eager-import";

const OWNER = "user-owner";
const future = new Date(Date.now() + 3_600_000).toISOString();

/** A parked Marketplace property as the callback leaves it: no owner, pending, a live ticket. */
function parked(id: string, createdAt: string, groupKey: string | null = null): Record<string, FakeRow> {
  return {
    hotel: {
      id,
      name: `Hotel ${id}`,
      is_active: false,
      setup_pending_at: createdAt,
      setup_deferred_at: null,
      external_enterprise_id: `cloudbeds:${id}`,
      created_at: createdAt,
    },
    connection: { hotel_id: id, pms_type: "cloudbeds", status: "pending" },
    claim: {
      token: `tok-${id}`,
      hotel_id: id,
      pms_type: "cloudbeds",
      property_name: `Hotel ${id}`,
      expires_at: future,
      claimed_by: null,
      claimed_at: null,
      group_key: groupKey,
    },
  };
}

function world(properties: Record<string, FakeRow>[], extra: Record<string, FakeRow[]> = {}) {
  state.db = fakeSupabase({
    hotels: properties.map((p) => p.hotel),
    pms_connections: properties.map((p) => p.connection),
    pms_marketplace_claims: properties.map((p) => p.claim),
    ...extra,
  });
  return state.db;
}

const jobsFor = (hotelId: string) => (state.db.tables.import_jobs ?? []).filter((j) => j.hotel_id === hotelId);
const hotelRow = (hotelId: string) => state.db.tables.hotels.find((h) => h.id === hotelId)!;
const connection = (hotelId: string) => state.db.tables.pms_connections.find((c) => c.hotel_id === hotelId)!;

/** What the subscribe screen does when it renders: the head of the owner's queue is imported. */
async function showSubscribeScreen() {
  const [next] = await listUnpaidMarketplaceHotels(state.db.client, OWNER);
  if (next) await queuePrePaymentImport(state.db.client, next.hotelId, OWNER);
  return next?.hotelId ?? null;
}

/** What the webhook does when a subscription lands. */
async function pay(hotelId: string, status = "trialing") {
  state.db.tables.hotel_subscriptions ??= [];
  state.db.tables.hotel_subscriptions.push({ hotel_id: hotelId, status });
  return activateMarketplaceHotelIfPending(state.db.client, hotelId, { requestedBy: OWNER });
}

beforeEach(() => {
  state.stripe = true;
});

describe("the claim", () => {
  it("queues exactly one import and leaves the property parked", async () => {
    world([parked("h1", "2026-09-16T10:00:00Z")]);

    const res = await redeemMarketplaceClaim("tok-h1", OWNER);

    expect(res).toMatchObject({ ok: true, hotelId: "h1" });
    expect(jobsFor("h1")).toHaveLength(1);
    expect(jobsFor("h1")[0]).toMatchObject({ status: "queued", phase: "discover", pms_type: "cloudbeds", requested_by: OWNER });
    // Reading is not paying: still parked, still pending, still invisible to the scheduler.
    expect(hotelRow("h1")).toMatchObject({ is_active: false });
    expect(hotelRow("h1").setup_pending_at).not.toBeNull();
    expect(connection("h1").status).toBe("pending");
    expect(state.db.tables.onboarding_states ?? []).toHaveLength(0);
  });

  it("does not queue a second import when the same owner claims again or the screen renders", async () => {
    world([parked("h1", "2026-09-16T10:00:00Z")]);
    await redeemMarketplaceClaim("tok-h1", OWNER);
    await redeemMarketplaceClaim("tok-h1", OWNER);
    await showSubscribeScreen();
    await showSubscribeScreen();
    expect(jobsFor("h1")).toHaveLength(1);
  });

  it("imports only the group property the owner is shown first, not every sibling", async () => {
    const group = "cloudbeds:group:g1,g2,g3";
    world([
      parked("g2", "2026-09-16T10:00:02Z", group),
      parked("g1", "2026-09-16T10:00:01Z", group),
      parked("g3", "2026-09-16T10:00:03Z", group),
    ]);

    // The link names g2, but the queue shows the oldest first.
    const res = await redeemMarketplaceClaim("tok-g2", OWNER);

    expect(res).toMatchObject({ ok: true, hotelIds: expect.arrayContaining(["g1", "g2", "g3"]) });
    expect(jobsFor("g1")).toHaveLength(1);
    expect(jobsFor("g2")).toHaveLength(0);
    expect(jobsFor("g3")).toHaveLength(0);
  });

  it("never imports an anonymous connect nobody claimed", async () => {
    world([parked("h1", "2026-09-16T10:00:00Z")]);
    const r = await queuePrePaymentImport(state.db.client, "h1", null);
    expect(r).toEqual({ queued: false, reason: "not_claimed" });
    expect(jobsFor("h1")).toHaveLength(0);
  });

  it("goes live at once on an install with no Stripe keys, adopting a single import", async () => {
    state.stripe = false;
    world([parked("h1", "2026-09-16T10:00:00Z")]);
    await redeemMarketplaceClaim("tok-h1", OWNER);
    expect(hotelRow("h1").is_active).toBe(true);
    expect(jobsFor("h1")).toHaveLength(1);
    expect(state.db.tables.onboarding_states[0]).toMatchObject({ hotel_id: "h1", import_job_id: jobsFor("h1")[0].id });
  });
});

describe("group siblings", () => {
  const group = "cloudbeds:group:g1,g2,g3";
  const three = () =>
    world([
      parked("g1", "2026-09-16T10:00:01Z", group),
      parked("g2", "2026-09-16T10:00:02Z", group),
      parked("g3", "2026-09-16T10:00:03Z", group),
    ]);

  it("imports the second sibling only when it becomes the property on the subscribe screen", async () => {
    three();
    await redeemMarketplaceClaim("tok-g1", OWNER);
    expect(jobsFor("g2")).toHaveLength(0);

    // Paying for the first adopts its import and moves the queue on...
    const paid = await pay("g1");
    expect(paid).toMatchObject({ activated: true, importJobId: jobsFor("g1")[0].id });
    expect(jobsFor("g1")).toHaveLength(1);
    expect(jobsFor("g2")).toHaveLength(0);

    // ...and only showing the next one reads it.
    expect(await showSubscribeScreen()).toBe("g2");
    expect(jobsFor("g2")).toHaveLength(1);
    expect(jobsFor("g3")).toHaveLength(0);
    expect(hotelRow("g2").is_active).toBe(false);
    expect(connection("g2").status).toBe("pending");
  });

  it("never imports a sibling the owner said Not now to", async () => {
    three();
    await redeemMarketplaceClaim("tok-g1", OWNER);
    // "Not now" on g1: the flag, and the import queued for it stops.
    hotelRow("g1").setup_deferred_at = "2026-09-16T10:05:00Z";
    expect(await stopPrePaymentImport(state.db.client, "g1")).toBe(1);
    expect(jobsFor("g1")[0]).toMatchObject({ status: "canceled" });

    // The screen moves on to g2, which is imported.
    expect(await showSubscribeScreen()).toBe("g2");
    expect(jobsFor("g2")).toHaveLength(1);

    // Asking for g1 directly while it is deferred reads nothing.
    expect(await queuePrePaymentImport(state.db.client, "g1", OWNER)).toEqual({ queued: false, reason: "deferred" });
    expect(jobsFor("g1")).toHaveLength(1);
    expect(jobsFor("g1")[0].status).toBe("canceled");

    // g3 was never shown and never deferred: still untouched.
    expect(jobsFor("g3")).toHaveLength(0);
  });

  it("carries on from where it stopped when a put-off property is set up again", async () => {
    three();
    await redeemMarketplaceClaim("tok-g1", OWNER);
    const job = jobsFor("g1")[0];
    job.phase = "historical";
    job.window_index = 2;
    hotelRow("g1").setup_deferred_at = "2026-09-16T10:05:00Z";
    await stopPrePaymentImport(state.db.client, "g1");

    hotelRow("g1").setup_deferred_at = null;
    const r = await queuePrePaymentImport(state.db.client, "g1", OWNER);

    expect(r).toEqual({ queued: true, jobId: job.id, resumed: true });
    expect(jobsFor("g1")).toHaveLength(1);
    expect(jobsFor("g1")[0]).toMatchObject({ status: "queued", phase: "historical", window_index: 2, last_error: null });
  });
});

describe("before payment, the queue spends nothing twice", () => {
  const claimedWith = (job: FakeRow | null, connectionStatus = "pending") => {
    const p = parked("h1", "2026-09-16T10:00:00Z");
    p.claim = { ...p.claim, claimed_by: OWNER, claimed_at: "2026-09-16T10:01:00Z" };
    p.connection = { ...p.connection, status: connectionStatus };
    world([p], {
      hotel_memberships: [{ hotel_id: "h1", user_id: OWNER, role: "hotel_admin", status: "active" }],
      import_jobs: job ? [{ id: "job-1", hotel_id: "h1", pms_type: "cloudbeds", created_at: "2026-09-16T10:01:01Z", stats: {}, ...job }] : [],
    });
  };

  it("leaves a finished import finished", async () => {
    claimedWith({ status: "completed", phase: "done" });
    expect(await queuePrePaymentImport(state.db.client, "h1", OWNER)).toEqual({ queued: false, reason: "imported", jobId: "job-1" });
  });

  it("does not retry a failed import for someone who has not paid", async () => {
    claimedWith({ status: "failed", phase: "historical" });
    expect(await queuePrePaymentImport(state.db.client, "h1", OWNER)).toEqual({ queued: false, reason: "failed_before", jobId: "job-1" });
    expect(jobsFor("h1")[0].status).toBe("failed");
  });

  it("does not queue a property whose connection is disconnected or gone", async () => {
    claimedWith(null, "disconnected");
    expect(await queuePrePaymentImport(state.db.client, "h1", OWNER)).toEqual({ queued: false, reason: "disconnected" });
    state.db.tables.pms_connections.length = 0;
    expect(await queuePrePaymentImport(state.db.client, "h1", OWNER)).toEqual({ queued: false, reason: "no_connection" });
    expect(jobsFor("h1")).toHaveLength(0);
  });

  it("treats a refused duplicate as the import already being queued", async () => {
    claimedWith(null);
    let raced = false;
    const inner = state.db;
    state.db = fakeSupabase(inner.tables, {
      fault: (call) => {
        if (!raced && call.table === "import_jobs" && call.op === "insert") {
          raced = true;
          return { code: "23505", message: "duplicate key value violates unique constraint" };
        }
        return null;
      },
    });
    const r = await queuePrePaymentImport(state.db.client, "h1", OWNER);
    expect(r).toMatchObject({ queued: false, reason: "in_flight" });
  });
});

describe("payment after an import at the claim", () => {
  it("adopts the running import, whatever phase it is in, and queues nothing new", async () => {
    world([parked("h1", "2026-09-16T10:00:00Z")]);
    await redeemMarketplaceClaim("tok-h1", OWNER);
    Object.assign(jobsFor("h1")[0], { status: "running", phase: "historical", window_index: 1 });

    const r = await pay("h1");

    expect(r).toMatchObject({ activated: true, importJobId: jobsFor("h1")[0].id });
    expect(jobsFor("h1")).toHaveLength(1);
    expect(jobsFor("h1")[0]).toMatchObject({ status: "running", phase: "historical" });
    expect(hotelRow("h1").is_active).toBe(true);
    expect(connection("h1").status).toBe("connected");
  });
});

describe("resumeStoppedImport on a paid reconnect", () => {
  const withJob = (status: string) => {
    const p = parked("h1", "2026-09-16T10:00:00Z");
    world([p], { import_jobs: [{ id: "job-1", hotel_id: "h1", status, phase: "historical", created_at: "2026-09-16T10:01:00Z", stats: {} }] });
  };

  it("picks up an import a disconnect stopped", async () => {
    withJob("canceled");
    expect(await resumeStoppedImport(state.db.client, "h1")).toBe(true);
    expect(jobsFor("h1")[0]).toMatchObject({ status: "queued", phase: "historical" });
  });

  it.each(["completed", "failed", "running"])("leaves a %s import alone: a reconnect is not a re-import", async (status) => {
    withJob(status);
    expect(await resumeStoppedImport(state.db.client, "h1")).toBe(false);
    expect(jobsFor("h1")[0].status).toBe(status);
  });
});
