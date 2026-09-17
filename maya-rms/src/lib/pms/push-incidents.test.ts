/**
 * Incidents turn a stream of refused rates into one item per cause: opened by
 * the first failure, fed every retry, shown to the owner only when a person
 * is needed, and closed when the cells land, get a new price or stop being
 * pushed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Alert } from "../../../supabase/functions/_shared/pms/alerting";
import { classifyPushFailure, type PushFailureInput } from "../../../supabase/functions/_shared/pms/push-failure";
import {
  ESCALATE_AFTER_MS,
  MAX_STORED_ATTEMPTS,
  type PushRunRecord,
  recordPushIncidents,
  type RunCell,
  type RunFailure,
} from "../../../supabase/functions/_shared/pms/push-incidents";
import { GUARDRAIL, NO_RATE_TARGET_REASON } from "../../../supabase/functions/_shared/pms/push-guardrails";
import { type FakeFault, fakeSupabase, type FakeRow } from "../engine/fake-supabase.test";

const HOTEL = "hotel-1";
const T0 = Date.parse("2026-09-17T10:00:00Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

const OUTAGE: PushFailureInput = { pms: "cloudbeds", phase: "send", message: "Cloudbeds patchRate failed (503): Service Unavailable" };
const DERIVED: PushFailureInput = { pms: "cloudbeds", phase: "guardrail", message: NO_RATE_TARGET_REASON, targetGap: "derived_only" };

let ids = 0;
let alerts: Alert[] = [];
const deps = {
  newId: () => `id-${++ids}`,
  alert: async (_s: unknown, a: Alert) => {
    alerts.push(a);
    return { sent: true };
  },
};

beforeEach(() => {
  ids = 0;
  alerts = [];
});

function failure(stayDate: string, roomTypeId: string, minutes: number, input: PushFailureInput = OUTAGE, price = 200): RunFailure {
  return {
    stayDate,
    roomTypeId,
    price,
    at: at(minutes),
    phase: input.phase,
    outcome: input.phase === "guardrail" ? "skipped" : "failed",
    httpStatus: null,
    message: input.message ?? null,
    jobReference: null,
    failure: classifyPushFailure(input),
  };
}

function failing(f: RunFailure): [string, RunCell] {
  return [`${f.stayDate}|${f.roomTypeId}`, { stayDate: f.stayDate, roomTypeId: f.roomTypeId, price: f.price, state: "failing", failure: f.failure }];
}

function landed(stayDate: string, roomTypeId: string, minutes: number, price = 200): [string, RunCell] {
  return [
    `${stayDate}|${roomTypeId}`,
    { stayDate, roomTypeId, price, state: "landed", sent: { at: at(minutes), phase: "send", jobReference: "job-9" } },
  ];
}

function tick(minutes: number, failures: RunFailure[], extraCells: [string, RunCell][] = [], mayHaveOpen = true): PushRunRecord {
  return {
    hotelId: HOTEL,
    pmsType: "cloudbeds",
    nowMs: T0 + minutes * 60_000,
    cells: new Map([...failures.map(failing), ...extraCells]),
    failures,
    mayHaveOpen,
  };
}

function db(seed: Record<string, FakeRow[]> = {}, fault?: FakeFault) {
  return fakeSupabase(seed, { fault });
}

describe("recordPushIncidents", () => {
  it("only asks whether anything is open when nothing failed and nothing is on record as failing", async () => {
    const fake = db();
    const res = await recordPushIncidents(fake.client, tick(0, [], [landed("2026-09-20", "rt-1", 0)], false), deps);
    expect(res).toBeNull();
    expect(fake.calls).toEqual([expect.objectContaining({ table: "rate_push_incidents", op: "select", columns: "id" })]);
  });

  it("closes an incident whose last cells landed on a run that could not write it, once the ledger shows nothing failing", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const scope: PushFailureInput = { pms: "cloudbeds", phase: "send", message: "Cloudbeds patchRate failed (403): scope required", httpStatus: 403 };
    let failWrites = false;
    const fake = db({}, (c) => (failWrites && c.table === "rate_push_incidents" && c.op === "upsert" ? { message: "connection reset" } : null));
    await recordPushIncidents(fake.client, tick(0, [failure("2026-09-20", "rt-1", 0, scope)]), deps);
    expect(fake.tables.rate_push_incidents[0]).toMatchObject({ cause: "missing_write_permission", resolved_at: null });

    // The owner fixed it and the cell landed, but that run's write failed.
    failWrites = true;
    expect(await recordPushIncidents(fake.client, tick(5, [], [landed("2026-09-20", "rt-1", 5)]), deps)).toMatchObject({
      error: expect.stringContaining("connection reset"),
    });
    expect(fake.tables.rate_push_incidents[0].resolved_at).toBeNull();

    // Every later run sees only sent rows in the ledger.
    failWrites = false;
    const res = await recordPushIncidents(fake.client, tick(10, [], [landed("2026-09-20", "rt-1", 5)], false), deps);
    expect(res).toMatchObject({ resolved: 1 });
    expect(fake.tables.rate_push_incidents[0]).toMatchObject({ resolved_at: at(10), resolution: "landed" });
    errors.mockRestore();
  });

  it("stops an open incident's cells once their nights leave the window, with nothing failing left in the ledger", async () => {
    const fake = db();
    const rejected: PushFailureInput = { pms: "cloudbeds", phase: "send", message: "Cloudbeds patchRate failed (400): Rate must be greater than 500" };
    await recordPushIncidents(fake.client, tick(0, [failure("2026-09-20", "rt-1", 0, rejected)]), deps);

    // The next day: tonight's night is gone from the push, and so from the run.
    const res = await recordPushIncidents(fake.client, tick(24 * 60, [], [landed("2026-09-21", "rt-1", 0)], false), deps);
    expect(res).toMatchObject({ resolved: 1 });
    expect(fake.tables.rate_push_incidents[0]).toMatchObject({ cause: "value_rejected", resolution: "stopped", cells_stopped: 1 });
  });

  it("files every cell a retrying cause hit under one incident, out of the owner's sight", async () => {
    const fake = db();
    const res = await recordPushIncidents(
      fake.client,
      tick(0, [failure("2026-09-20", "rt-1", 0), failure("2026-09-21", "rt-1", 0), failure("2026-09-20", "rt-2", 0)], [], false),
      deps,
    );
    expect(res).toMatchObject({ opened: 1, escalated: 0, attemptsStored: 3 });
    expect(fake.tables.rate_push_incidents).toEqual([
      expect.objectContaining({
        hotel_id: HOTEL,
        pms_type: "cloudbeds",
        cause: "pms_unavailable",
        known: true,
        severity: "transient",
        admin_only: false,
        attempt_count: 3,
        customer_visible_at: null,
        resolved_at: null,
      }),
    ]);
    expect(fake.tables.rate_push_incident_cells).toHaveLength(3);
    expect(fake.tables.rate_push_attempts[0]).toMatchObject({
      phase: "send",
      outcome: "failed",
      message: "Cloudbeds patchRate failed (503): Service Unavailable",
      stay_date: "2026-09-20",
    });
    expect(alerts).toEqual([]);
  });

  it("closes as landed when a retry gets through, and never shows or alerts", async () => {
    const fake = db();
    await recordPushIncidents(fake.client, tick(0, [failure("2026-09-20", "rt-1", 0), failure("2026-09-21", "rt-1", 0)]), deps);
    await recordPushIncidents(fake.client, tick(5, [failure("2026-09-21", "rt-1", 5)], [landed("2026-09-20", "rt-1", 5)]), deps);
    const res = await recordPushIncidents(fake.client, tick(10, [], [landed("2026-09-21", "rt-1", 10), landed("2026-09-20", "rt-1", 5)]), deps);

    expect(res).toMatchObject({ resolved: 1 });
    const [incident] = fake.tables.rate_push_incidents;
    expect(incident).toMatchObject({ resolution: "landed", resolved_at: at(10), customer_visible_at: null, attempt_count: 5, cells_landed: 2 });
    expect(fake.tables.rate_push_attempts.map((a) => `${a.attempted_at} ${a.stay_date} ${a.outcome}`)).toEqual([
      `${at(0)} 2026-09-20 failed`,
      `${at(0)} 2026-09-21 failed`,
      `${at(5)} 2026-09-21 failed`,
      `${at(5)} 2026-09-20 landed`,
      `${at(10)} 2026-09-21 landed`,
    ]);
    expect(alerts).toEqual([]);
  });

  it("shows a known critical cause to the owner at once, with one critical alert naming the cause and not the vendor's text", async () => {
    const fake = db();
    const first = await recordPushIncidents(fake.client, tick(0, [failure("2026-09-20", "rt-1", 0, DERIVED)]), deps);
    expect(first).toMatchObject({ opened: 1, escalated: 1 });
    expect(fake.tables.rate_push_incidents[0]).toMatchObject({
      cause: "rate_plan_not_updatable",
      severity: "critical",
      customer_visible_at: at(0),
      alerted_at: at(0),
    });
    expect(alerts).toEqual([
      expect.objectContaining({ severity: "critical", key: `rate_push:rate_plan_not_updatable:${HOTEL}`, hotelId: HOTEL }),
    ]);
    expect(alerts[0].detail).toContain("1 night, 1 room type");

    // Still failing next tick, with nothing new tried: no second alert.
    const [key, cell] = failing(failure("2026-09-20", "rt-1", 5, DERIVED));
    await recordPushIncidents(fake.client, tick(5, [], [[key, cell]]), deps);
    expect(alerts).toHaveLength(1);
    expect(fake.tables.rate_push_incidents[0].resolved_at).toBeNull();
  });

  it("brings a retrying cause to the owner once a cell has failed for two hours over five tries", async () => {
    const fake = db();
    for (let n = 0; n < 5; n++) {
      await recordPushIncidents(fake.client, tick(n * 5, [failure("2026-09-20", "rt-1", n * 5)]), deps);
    }
    expect(fake.tables.rate_push_incidents[0].customer_visible_at).toBeNull();

    const later = ESCALATE_AFTER_MS / 60_000;
    const [key, cell] = failing(failure("2026-09-20", "rt-1", later));
    const res = await recordPushIncidents(fake.client, tick(later, [], [[key, cell]]), deps);
    expect(res).toMatchObject({ escalated: 1 });
    expect(fake.tables.rate_push_incidents[0]).toMatchObject({ customer_visible_at: at(later), alerted_at: at(later) });
    expect(alerts).toEqual([expect.objectContaining({ severity: "critical", title: "Rates not reaching Cloudbeds: pms unavailable" })]);
  });

  it("does not alert a revoked grant, which connection health already reports", async () => {
    const fake = db();
    await recordPushIncidents(
      fake.client,
      tick(0, [failure("2026-09-20", "rt-1", 0, { pms: "cloudbeds", phase: "send", message: "Cloudbeds patchRate failed (401): expired" })]),
      deps,
    );
    expect(fake.tables.rate_push_incidents[0]).toMatchObject({ cause: "auth_revoked", alerted_at: null });
    expect(fake.tables.rate_push_incidents[0].customer_visible_at).not.toBeNull();
    expect(alerts).toEqual([]);
  });

  it("keeps guardrail holds from owners, and warns only when one means MAYA published a bad row", async () => {
    const fake = db();
    await recordPushIncidents(
      fake.client,
      tick(0, [
        failure("2026-09-20", "rt-1", 0, { pms: "cloudbeds", phase: "guardrail", message: GUARDRAIL.invalidPrice }),
        failure("2026-09-20", "rt-2", 0, { pms: "cloudbeds", phase: "guardrail", message: GUARDRAIL.inactiveRoomType }),
        // A floor raised after the night was published: expected, not a bug.
        failure("2026-09-20", "rt-3", 0, { pms: "cloudbeds", phase: "guardrail", message: GUARDRAIL.belowFloor }),
      ]),
      deps,
    );
    const rows = fake.tables.rate_push_incidents;
    expect(rows.map((r) => [r.cause, r.admin_only, r.customer_visible_at])).toEqual([
      ["guardrail_invalid_price", true, null],
      ["guardrail_inactive_room_type", true, null],
      ["guardrail_below_floor", true, null],
    ]);
    expect(alerts).toEqual([expect.objectContaining({ severity: "warn", key: `rate_push:guardrail_invalid_price:${HOTEL}` })]);
  });

  it("closes a cell as superseded by a new price or another cause, and as stopped once it is not pushed", async () => {
    const fake = db();
    await recordPushIncidents(
      fake.client,
      tick(0, [failure("2026-09-20", "rt-1", 0), failure("2026-09-21", "rt-1", 0), failure("2026-09-22", "rt-1", 0)]),
      deps,
    );
    const refused = failure("2026-09-21", "rt-1", 5, { pms: "cloudbeds", phase: "send", message: "Rate must be greater than 500" });
    const res = await recordPushIncidents(fake.client, tick(5, [refused], [landed("2026-09-20", "rt-1", 5, 215)]), deps);

    expect(res).toMatchObject({ opened: 1, resolved: 1 });
    const [outage, value] = fake.tables.rate_push_incidents;
    expect(outage).toMatchObject({ cause: "pms_unavailable", resolution: "superseded", cells_superseded: 2, cells_stopped: 1 });
    expect(value).toMatchObject({ cause: "value_rejected", resolved_at: null, customer_visible_at: at(5) });
    const states = Object.fromEntries(
      fake.tables.rate_push_incident_cells.filter((c) => c.incident_id === outage.id).map((c) => [c.stay_date, c.state]),
    );
    expect(states).toEqual({ "2026-09-20": "superseded", "2026-09-21": "superseded", "2026-09-22": "stopped" });
  });

  it("files a skip whose row did not change under the cause it fails for now, and counts nothing while it stays open there", async () => {
    const fake = db();
    const unreadable: PushFailureInput = { ...DERIVED, targetGap: "catalog_unavailable" };
    // Filed as an outage on a tick whose catalog read failed.
    await recordPushIncidents(fake.client, tick(0, [failure("2026-09-20", "rt-1", 0, unreadable)]), deps);
    expect(fake.tables.rate_push_incidents[0]).toMatchObject({ cause: "pms_unavailable" });

    // The next read says its rates follow another plan. The ledger row reads the same.
    const ongoing = { ...failure("2026-09-20", "rt-1", 5, DERIVED), ongoing: true };
    const res = await recordPushIncidents(fake.client, tick(5, [ongoing]), deps);
    expect(res).toMatchObject({ opened: 1, resolved: 1 });
    expect(fake.tables.rate_push_incidents.map((i) => [i.cause, i.resolution])).toEqual([
      ["pms_unavailable", "superseded"],
      ["rate_plan_not_updatable", null],
    ]);
    expect(fake.tables.rate_push_incidents[1].customer_visible_at).toBe(at(5));

    // Still so on later ticks: nothing new is counted or stored.
    const attempts = fake.tables.rate_push_attempts.length;
    const later = await recordPushIncidents(fake.client, tick(10, [{ ...failure("2026-09-20", "rt-1", 10, DERIVED), ongoing: true }]), deps);
    expect(later).toMatchObject({ opened: 0, reopened: 0, resolved: 0, attemptsStored: 0 });
    expect(fake.tables.rate_push_attempts).toHaveLength(attempts);
    expect(fake.tables.rate_push_incidents[1]).toMatchObject({ attempt_count: 1, resolved_at: null });
  });

  it("leaves a cell the run could not get to open", async () => {
    const fake = db();
    await recordPushIncidents(fake.client, tick(0, [failure("2026-09-20", "rt-1", 0)]), deps);
    const waiting: [string, RunCell] = ["2026-09-20|rt-1", { stayDate: "2026-09-20", roomTypeId: "rt-1", price: 200, state: "waiting" }];
    const res = await recordPushIncidents(fake.client, tick(5, [], [waiting]), deps);
    expect(res).toMatchObject({ resolved: 0 });
    expect(fake.tables.rate_push_incidents[0].resolved_at).toBeNull();
  });

  it("reopens an incident that closed within the hour when the same cause comes back", async () => {
    const fake = db();
    await recordPushIncidents(fake.client, tick(0, [failure("2026-09-20", "rt-1", 0)]), deps);
    await recordPushIncidents(fake.client, tick(5, [], [landed("2026-09-20", "rt-1", 5)]), deps);
    expect(fake.tables.rate_push_incidents[0].resolved_at).toBe(at(5));

    const res = await recordPushIncidents(fake.client, tick(10, [failure("2026-09-20", "rt-1", 10)]), deps);
    expect(res).toMatchObject({ opened: 0, reopened: 1 });
    expect(fake.tables.rate_push_incidents).toHaveLength(1);
    expect(fake.tables.rate_push_incidents[0]).toMatchObject({ resolved_at: null, resolution: null, cells_landed: 0 });
    // A new episode for the cell: its tries and its start count from the reopening.
    expect(fake.tables.rate_push_incident_cells[0]).toMatchObject({ state: "open", attempts: 1, first_attempt_at: at(10), closed_at: null });

    // Past the hour, the same cause is a new incident.
    await recordPushIncidents(fake.client, tick(15, [], [landed("2026-09-20", "rt-1", 15)]), deps);
    await recordPushIncidents(fake.client, tick(90, [failure("2026-09-20", "rt-1", 90)]), deps);
    expect(fake.tables.rate_push_incidents).toHaveLength(2);
  });

  it("never shows the owner a cell that landed a few minutes after each of many short outages", async () => {
    const fake = db();
    const throttled: PushFailureInput = { pms: "cloudbeds", phase: "send", message: "Cloudbeds patchRate failed (429): Too many requests" };
    // Refused every half hour, landing five minutes later each time. The
    // incident closes and reopens within the hour, so it is one incident.
    for (const m of [0, 30, 60, 90, 120]) {
      await recordPushIncidents(fake.client, tick(m, [failure("2026-09-20", "rt-1", m, throttled)]), deps);
      await recordPushIncidents(fake.client, tick(m + 5, [], [landed("2026-09-20", "rt-1", m + 5)]), deps);
    }
    expect(fake.tables.rate_push_incidents).toHaveLength(1);
    expect(fake.tables.rate_push_incidents[0]).toMatchObject({ attempt_count: 10, customer_visible_at: null, alerted_at: null });
    expect(alerts).toEqual([]);
  });

  it("writes the incident before any alert goes out, and leaves the alert for the next run when the deadline is close", async () => {
    const fake = db();
    const seen: number[] = [];
    const slow = {
      ...deps,
      alert: async (_s: unknown, a: Alert) => {
        seen.push((fake.tables.rate_push_incidents ?? []).length);
        alerts.push(a);
        return { sent: true };
      },
    };
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const near = { ...tick(0, [failure("2026-09-20", "rt-1", 0, DERIVED)]), deadlineAt: Date.now() + 2_000 };
    const res = await recordPushIncidents(fake.client, near, slow);
    expect(res).toMatchObject({ opened: 1, escalated: 1 });
    expect(alerts).toEqual([]);
    expect(fake.tables.rate_push_incidents[0]).toMatchObject({ customer_visible_at: at(0), alerted_at: null });
    expect(fake.tables.rate_push_incident_cells).toHaveLength(1);
    logs.mockRestore();

    // Time enough on the next run: the alert goes out after the writes, and is marked.
    const [key, cell] = failing(failure("2026-09-20", "rt-1", 5, DERIVED));
    await recordPushIncidents(fake.client, { ...tick(5, [], [[key, cell]]), deadlineAt: Date.now() + 60_000 }, slow);
    expect(seen).toEqual([1]);
    expect(alerts).toHaveLength(1);
    expect(fake.tables.rate_push_incidents[0].alerted_at).toBe(at(5));
  });

  it("stops storing tries past the cap but keeps counting them", async () => {
    const fake = db();
    const many: RunFailure[] = [];
    for (let i = 0; i <= MAX_STORED_ATTEMPTS; i++) {
      many.push(failure(`2026-10-${String((i % 28) + 1).padStart(2, "0")}`, `rt-${Math.floor(i / 28)}`, 0));
    }
    const res = await recordPushIncidents(fake.client, tick(0, many), deps);
    expect(res).toMatchObject({ attemptsStored: MAX_STORED_ATTEMPTS });
    expect(fake.tables.rate_push_attempts).toHaveLength(MAX_STORED_ATTEMPTS);
    expect(fake.tables.rate_push_incidents[0]).toMatchObject({
      attempt_count: MAX_STORED_ATTEMPTS + 1,
      attempts_stored: MAX_STORED_ATTEMPTS,
    });
  });

  it("never throws: a failed write is logged and returned", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = db({}, (c) => (c.table === "rate_push_incidents" && c.op === "upsert" ? { message: "relation does not exist" } : null));
    const res = await recordPushIncidents(fake.client, tick(0, [failure("2026-09-20", "rt-1", 0)]), deps);
    expect(res).toEqual({ error: "incidents write: relation does not exist" });
    expect(errors.mock.calls.some((c) => String(c[0]).includes("rate_push_incident_write_failed"))).toBe(true);
    expect(fake.tables.rate_push_attempts ?? []).toHaveLength(0);
    errors.mockRestore();
  });
});
