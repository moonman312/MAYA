import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  BILLING_PROBLEM_EVENT,
  BILLING_SWEEP_EVENT,
  HOUR_MS,
  lastBillingSweep,
  recordBillingProblem,
  recordBillingSweep,
} from "./problems";

const NOW = new Date("2026-10-01T12:00:00Z");

/** platform_audit_events as the service role sees it: newest-row reads, and platform_log_event. */
function fakeAdmin(opts: { rows?: { event_type: string; entity_id: string; created_at: string; detail?: unknown }[]; rpcErrors?: ({ code?: string; message: string } | null)[]; readError?: string } = {}) {
  const rows = [...(opts.rows ?? [])];
  const rpcs: Record<string, unknown>[] = [];
  const rpcErrors = [...(opts.rpcErrors ?? [])];
  const admin = {
    from: () => {
      const filters: Record<string, unknown> = {};
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          return chain;
        },
        order: () => chain,
        limit: async () => {
          if (opts.readError) return { data: null, error: { message: opts.readError } };
          const found = rows
            .filter((r) => r.event_type === filters.event_type && r.entity_id === filters.entity_id)
            .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
          return { data: found.slice(0, 1), error: null };
        },
      };
      return chain;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcs.push({ fn, ...args });
      return { error: rpcErrors.shift() ?? null };
    },
  } as unknown as SupabaseClient;
  return { admin, rpcs };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("recordBillingProblem", () => {
  it("writes a billing.problem row the watchdog posts, critical by default", async () => {
    const { admin, rpcs } = fakeAdmin();
    const res = await recordBillingProblem(admin, { key: "billing-x:h1", hotelId: "h1", title: "T", detail: "D" });
    expect(res).toEqual({ recorded: true });
    expect(rpcs).toEqual([
      {
        fn: "platform_log_event",
        p_event_type: BILLING_PROBLEM_EVENT,
        p_entity_type: "billing",
        p_entity_id: "billing-x:h1",
        p_hotel_id: "h1",
        p_detail: { severity: "critical", title: "T", detail: "D", hotel_id: "h1" },
      },
    ]);
  });

  it("stays quiet when the same key was written inside the window, and writes again after it", async () => {
    const recent = { event_type: BILLING_PROBLEM_EVENT, entity_id: "k", created_at: new Date(NOW.getTime() - HOUR_MS).toISOString() };
    const quiet = fakeAdmin({ rows: [recent] });
    expect(await recordBillingProblem(quiet.admin, { key: "k", title: "T", detail: "D" }, { quietForMs: 6 * HOUR_MS, now: NOW })).toEqual({ recorded: false });
    expect(quiet.rpcs).toHaveLength(0);
    const later = fakeAdmin({ rows: [recent] });
    expect(await recordBillingProblem(later.admin, { key: "k", title: "T", detail: "D" }, { quietForMs: 30 * 60_000, now: NOW })).toEqual({ recorded: true });
  });

  it("keeps the problem when its hotel is gone, with the id in the detail", async () => {
    const { admin, rpcs } = fakeAdmin({ rpcErrors: [{ code: "23503", message: "violates foreign key constraint" }] });
    expect(await recordBillingProblem(admin, { key: "k", hotelId: "gone", title: "T", detail: "D" })).toEqual({ recorded: true });
    expect(rpcs).toHaveLength(2);
    expect(rpcs[1]).not.toHaveProperty("p_hotel_id");
    expect(rpcs[1].p_detail).toMatchObject({ hotel_id: "gone" });
  });

  it("never throws: a failed write or read is logged and reported as not recorded", async () => {
    const failing = fakeAdmin({ rpcErrors: [{ message: "permission denied" }] });
    expect(await recordBillingProblem(failing.admin, { key: "k", title: "T", detail: "D" })).toEqual({ recorded: false });
    const unreadable = fakeAdmin({ readError: "timeout" });
    expect(await recordBillingProblem(unreadable.admin, { key: "k", title: "T", detail: "D" }, { quietForMs: HOUR_MS })).toEqual({ recorded: false });
    const broken = { from: () => { throw new Error("no client"); }, rpc: () => { throw new Error("no client"); } } as unknown as SupabaseClient;
    expect(await recordBillingProblem(broken, { key: "k", title: "T", detail: "D" })).toEqual({ recorded: false });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("recordBillingProblem"));
  });
});

describe("recordBillingSweep", () => {
  it("writes a billing.sweep row under the job with its counts", async () => {
    const { admin, rpcs } = fakeAdmin();
    await recordBillingSweep(admin, "room-truing", { examined: 3 }, { now: NOW });
    expect(rpcs).toEqual([
      {
        fn: "platform_log_event",
        p_event_type: BILLING_SWEEP_EVENT,
        p_entity_type: "billing_job",
        p_entity_id: "room-truing",
        p_detail: { job: "room-truing", examined: 3 },
      },
    ]);
  });

  it("writes at most once per window when asked, so a 15-minute job is not a row every run", async () => {
    const rows = [{ event_type: BILLING_SWEEP_EVENT, entity_id: "card-reverify", created_at: new Date(NOW.getTime() - 20 * 60_000).toISOString() }];
    const { admin, rpcs } = fakeAdmin({ rows });
    expect(await recordBillingSweep(admin, "card-reverify", {}, { everyMs: 55 * 60_000, now: NOW })).toEqual({ recorded: false });
    expect(await recordBillingSweep(admin, "card-reverify", {}, { everyMs: 55 * 60_000, now: new Date(NOW.getTime() + 40 * 60_000) })).toEqual({ recorded: true });
    expect(rpcs).toHaveLength(1);
  });
});

describe("lastBillingSweep", () => {
  it("reads the newest run of a job, or null", async () => {
    const rows = [
      { event_type: BILLING_SWEEP_EVENT, entity_id: "stripe-reconcile", created_at: "2026-09-30T03:00:00Z", detail: { cursor: "a" } },
      { event_type: BILLING_SWEEP_EVENT, entity_id: "stripe-reconcile", created_at: "2026-10-01T03:00:00Z", detail: { cursor: "b" } },
    ];
    expect(await lastBillingSweep(fakeAdmin({ rows }).admin, "stripe-reconcile")).toEqual({ at: "2026-10-01T03:00:00Z", detail: { cursor: "b" } });
    expect(await lastBillingSweep(fakeAdmin().admin, "stripe-reconcile")).toBeNull();
    expect(await lastBillingSweep(fakeAdmin({ readError: "x" }).admin, "stripe-reconcile")).toBeNull();
  });
});
