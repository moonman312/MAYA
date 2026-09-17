/**
 * The admin panel says how often each reason rates did not land came up, how
 * it ended, and what the PMS said when nobody knows why.
 */
import { describe, expect, it } from "vitest";
import { fakeSupabase, missingRelation, type FakeRow } from "@/lib/engine/fake-supabase.test";
import { aggregatePushProblems, loadPushProblemAnalytics, type PushIncidentRow } from "./push-problems";

const incident = (over: Partial<PushIncidentRow>): PushIncidentRow => ({
  id: "i",
  hotel_id: "h1",
  pms_type: "cloudbeds",
  cause: "pms_unavailable",
  opened_at: "2026-09-10T10:00:00Z",
  attempt_count: 3,
  customer_visible_at: null,
  resolved_at: null,
  resolution: null,
  ...over,
});

describe("aggregatePushProblems", () => {
  it("counts incidents, tries and hotels per cause, and how each ended", () => {
    const rows = aggregatePushProblems([
      incident({ id: "a", attempt_count: 4, resolved_at: "2026-09-10T11:00:00Z", resolution: "landed" }),
      incident({ id: "b", hotel_id: "h2", attempt_count: 12, resolved_at: "2026-09-10T13:00:00Z", resolution: "landed" }),
      incident({ id: "c", hotel_id: "h2", attempt_count: 40, customer_visible_at: "2026-09-10T12:00:00Z", resolved_at: "2026-09-10T15:00:00Z", resolution: "landed" }),
      incident({ id: "d", attempt_count: 1 }),
      incident({ id: "e", cause: "rate_plan_not_updatable", customer_visible_at: "2026-09-10T10:00:00Z", attempt_count: 1 }),
    ]);
    expect(rows[0]).toMatchObject({
      cause: "pms_unavailable",
      known: true,
      guardrail: false,
      incidents: 4,
      attempts: 57,
      hotels: 2,
      resolvedByRetry: 2,
      escalated: 1,
      open: 1,
      medianHoursToLand: 3,
      sampleMessages: [],
    });
    expect(rows[1]).toMatchObject({ cause: "rate_plan_not_updatable", known: true, incidents: 1, escalated: 1, open: 1, medianHoursToLand: null });
  });

  it("flags unknown causes and lists what the PMS said, most frequent first", () => {
    const rows = aggregatePushProblems(
      [incident({ id: "u1", cause: "unknown" }), incident({ id: "u2", cause: "unknown" }), incident({ id: "g", cause: "guardrail_stale_price" })],
      new Map([
        ["u1", ["Cloudbeds patchRate failed (400): Odd thing", "Cloudbeds patchRate failed (400): Rare thing"]],
        ["u2", ["Cloudbeds patchRate failed (400): Odd thing"]],
        ["g", ["guardrail:stale_price"]],
      ]),
    );
    expect(rows.map((r) => [r.cause, r.known, r.guardrail, r.mayaBug])).toEqual([
      ["unknown", false, false, false],
      ["guardrail_stale_price", true, true, true],
    ]);
    expect(rows[0].sampleMessages).toEqual(["Cloudbeds patchRate failed (400): Odd thing", "Cloudbeds patchRate failed (400): Rare thing"]);
    expect(rows[1].sampleMessages).toEqual([]);
  });
});

describe("loadPushProblemAnalytics", () => {
  const seed = (): Record<string, FakeRow[]> => ({
    hotels: [
      { id: "h1", name: "Seaview Inn", is_test: false },
      { id: "h-test", name: "Sandbox", is_test: true },
    ],
    rate_push_incidents: [
      incident({ id: "in-range", opened_at: "2026-09-14T09:00:00Z", cause: "unknown" }),
      incident({ id: "last-day", opened_at: "2026-09-20T23:59:00Z", resolved_at: "2026-09-21T00:30:00Z", resolution: "landed" }),
      incident({ id: "before", opened_at: "2026-09-01T09:00:00Z", customer_visible_at: "2026-09-01T11:00:00Z" }),
      incident({ id: "sandbox", hotel_id: "h-test", opened_at: "2026-09-15T09:00:00Z" }),
    ] as unknown as FakeRow[],
    rate_push_attempts: [
      { id: "a1", incident_id: "in-range", attempted_at: "2026-09-14T09:00:00Z", message: "Cloudbeds patchRate failed (400): Odd thing" },
    ],
  });

  it("reads the range, leaves test properties out, and lists every hotel with one open now", async () => {
    const { client } = fakeSupabase(seed());
    const res = await loadPushProblemAnalytics(client, "2026-09-14", "2026-09-20", false);
    if (!res.available) throw new Error("expected data");
    expect(res.causes.map((c) => [c.cause, c.incidents])).toEqual([
      ["unknown", 1],
      ["pms_unavailable", 1],
    ]);
    expect(res.causes[0].sampleMessages).toEqual(["Cloudbeds patchRate failed (400): Odd thing"]);
    expect(res.open.map((o) => [o.incidentId, o.hotelName, o.shownToOwner])).toEqual([
      ["before", "Seaview Inn", true],
      ["in-range", "Seaview Inn", false],
    ]);

    const withTest = await loadPushProblemAnalytics(fakeSupabase(seed()).client, "2026-09-14", "2026-09-20", true);
    if (!withTest.available) throw new Error("expected data");
    expect(withTest.causes.find((c) => c.cause === "pms_unavailable")?.incidents).toBe(2);
  });

  it("says the migration is missing instead of failing the page", async () => {
    const { client } = fakeSupabase(seed(), { fault: (c) => (c.table === "rate_push_incidents" ? missingRelation(c.table) : null) });
    expect(await loadPushProblemAnalytics(client, "2026-09-14", "2026-09-20", false)).toEqual({
      available: false,
      reason: "Run 99_supabase_migration_push_guardrails_v1.sql to see rate push problems.",
    });
  });
});
