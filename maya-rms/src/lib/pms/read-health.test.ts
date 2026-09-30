/**
 * Reads of a property system that keep failing (audit A12, decided
 * 2026-09-29): pricing stays held, the alert channel hears after three
 * failed reads in a row or thirty minutes without a good one, the
 * connection reads Error after about an hour, and the first good read posts
 * a recovery line and clears the rest. A refused login is not counted here
 * (that is A7's path). One failing-then-recovering sequence, as the scheduled
 * sync drives it, plus the edges.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Alert } from "../../../supabase/functions/_shared/pms/alerting";
import { raiseRecovery } from "../../../supabase/functions/_shared/pms/alerting";
import {
  noteReadFailure,
  noteReadRecovered,
  READ_FAILING_ALERT_AFTER_MS,
  READ_FAILING_ERROR_AFTER_MS,
  READ_FAILURES_BEFORE_ALERT,
  READ_FAILURES_BEFORE_CLOCK,
  readHealthAfterSync,
  readsFailingAlertKey,
} from "../../../supabase/functions/_shared/pms/connection-health";
import { fakeSupabase, type FakeRow } from "../engine/fake-supabase.test";

const H = "h1";
const MIN = 60_000;
const T0 = Date.parse("2026-10-06T09:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

function world(connection: Partial<FakeRow> = {}) {
  const fake = fakeSupabase({
    pms_connections: [
      { id: "conn-1", hotel_id: H, pms_type: "cloudbeds", status: "connected", sync_failures: 0, last_sync_at: iso(T0 - 5 * MIN), ...connection },
    ],
    platform_audit_events: [],
  });
  const alerts: Alert[] = [];
  const recoveries: { key: string; title: string; detail?: string }[] = [];
  const alert = async (_s: SupabaseClient, a: Alert) => {
    alerts.push(a);
    return { sent: true };
  };
  const recover = async (_s: SupabaseClient, r: { key: string; title: string; detail?: string }) => {
    recoveries.push(r);
    return { sent: true };
  };
  /** What release_pms_sync does after the tick: count the failure, or reset. */
  const release = (ok: boolean) => {
    const row = fake.tables.pms_connections[0];
    row.sync_failures = ok ? 0 : Number(row.sync_failures) + 1;
  };
  /** What a good sync stamps before the release. */
  const goodRead = (atMs: number) => {
    const row = fake.tables.pms_connections[0];
    row.last_sync_at = iso(atMs);
    if (row.status === "error" || row.status === "degraded") row.status = "connected";
  };
  /** The audit events logged through platform_log_event (the fake's rpc records the call, it writes no row). */
  const events = () => fake.calls.filter((c) => c.table === "rpc:platform_log_event").map((c) => (c.payload as { p_event_type: string }).p_event_type);
  return { ...fake, alerts, recoveries, alert, recover, release, goodRead, events, connection: () => fake.tables.pms_connections[0] };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("reads that keep failing, then work again", () => {
  it("holds its tongue for two failures, alerts on the third, reads Error after an hour, and recovers on the first good read", async () => {
    const w = world();
    const fail = async (atMs: number) => {
      const out = await readHealthAfterSync(w.client, H, "cloudbeds", { ok: false, error: "Cloudbeds getReservations failed (503): unavailable" }, {
        nowMs: atMs,
        alert: w.alert,
      });
      w.release(false);
      return out;
    };

    // 09:05: the first failed read, five minutes after a good one. Nothing said.
    const first = await fail(T0);
    expect(first).toMatchObject({ outcome: "failed", health: { failures: 1, minutesSinceGoodRead: 5, alert: null, markedError: false } });
    expect(w.alerts).toEqual([]);
    expect(w.connection().status).toBe("connected");

    // 09:15 (10 minutes later): the second. Still nothing.
    const second = await fail(T0 + 10 * MIN);
    expect(second).toMatchObject({ outcome: "failed", health: { failures: 2, alert: null, markedError: false } });
    expect(w.alerts).toEqual([]);

    // 09:30: the third in a row. The alert channel hears, and the connection still reads Connected.
    const third = await fail(T0 + 25 * MIN);
    expect(third).toMatchObject({ outcome: "failed", health: { failures: 3, minutesSinceGoodRead: 30, alert: { sent: true }, markedError: false } });
    expect(w.alerts).toEqual([
      expect.objectContaining({
        severity: "critical",
        key: readsFailingAlertKey("cloudbeds", H),
        title: "cloudbeds reads keep failing",
        hotelId: H,
        detail: expect.stringMatching(/^No good read for 30 minutes; 3 failed reads in a row\. Pricing is held/),
      }),
    ]);
    expect(w.connection().status).toBe("connected");
    expect(w.events()).toEqual([]);

    // 09:45: the fourth. Told again (raiseAlert dedupes for real); not Error yet.
    const fourth = await fail(T0 + 40 * MIN);
    expect(fourth).toMatchObject({ outcome: "failed", health: { failures: 4, markedError: false } });
    expect(w.connection().status).toBe("connected");

    // 10:05: an hour without a good read. Error, so the outage email and the banner follow.
    const hour = await fail(T0 + 60 * MIN);
    expect(hour).toMatchObject({ outcome: "failed", health: { failures: 5, minutesSinceGoodRead: 65, markedError: true, alert: { sent: true } } });
    expect(w.connection().status).toBe("error");
    expect(w.events()).toEqual(["pms.reads_failing"]);
    expect(w.alerts[w.alerts.length - 1].detail).toContain("The connection now reads Error, so the owner is emailed in an hour.");

    // 10:20: still failing. Error stays Error, said once.
    const later = await fail(T0 + 75 * MIN);
    expect(later).toMatchObject({ outcome: "failed", health: { failures: 6, markedError: false } });
    expect(w.events()).toEqual(["pms.reads_failing"]);

    // 10:35: a good read. The sync stamps Connected; the recovery line goes out, naming the streak.
    w.goodRead(T0 + 90 * MIN);
    const back = await readHealthAfterSync(w.client, H, "cloudbeds", { ok: true }, { recover: w.recover });
    expect(back).toEqual({ outcome: "recovered", failures: 6, recovery: { sent: true } });
    expect(w.recoveries).toEqual([
      { key: readsFailingAlertKey("cloudbeds", H), title: "cloudbeds reads are working again", detail: "6 failed reads in a row before this one. Pricing resumes with this read.", hotelId: H },
    ]);
    w.release(true);
    expect(w.connection()).toMatchObject({ status: "connected", sync_failures: 0 });

    // 10:40: another good read says nothing.
    w.goodRead(T0 + 95 * MIN);
    expect(await readHealthAfterSync(w.client, H, "cloudbeds", { ok: true }, { recover: w.recover })).toEqual({ outcome: "ok", failures: 0, recovery: null });
    expect(w.recoveries).toHaveLength(1);
  });

  it("alerts on thirty minutes without a good read once a second read has failed, and never counts a refused login", async () => {
    const w = world({ last_sync_at: iso(T0 - 35 * MIN) });
    // The first failure after 35 quiet minutes says nothing: the gap was not the reads' doing.
    const first = await readHealthAfterSync(w.client, H, "cloudbeds", { ok: false, error: "timed out" }, { nowMs: T0, alert: w.alert });
    expect(first).toMatchObject({ outcome: "failed", health: { failures: 1, minutesSinceGoodRead: 35, alert: null, markedError: false } });
    expect(w.alerts).toEqual([]);
    w.release(false);
    // The second, on the retry: the streak is the reads' own, and the clock counts.
    const second = await readHealthAfterSync(w.client, H, "cloudbeds", { ok: false, error: "timed out" }, { nowMs: T0 + 10 * MIN, alert: w.alert });
    expect(second).toMatchObject({ outcome: "failed", health: { failures: 2, minutesSinceGoodRead: 45, alert: { sent: true }, markedError: false } });
    expect(w.alerts[0].detail).toMatch(/^No good read for 45 minutes; 2 failed reads in a row/);

    // A refused login is A7's: disconnected or counted there, not here.
    const refused = await readHealthAfterSync(w.client, H, "cloudbeds", { ok: false, error: "401", refusal: "refused" }, { nowMs: T0, alert: w.alert });
    expect(refused).toEqual({ outcome: "refused" });
    expect(w.alerts).toHaveLength(1);
    // A read the tick skipped says nothing either.
    expect(await readHealthAfterSync(w.client, H, "cloudbeds", { ok: true, skipped: "import_running" }, { alert: w.alert })).toEqual({ outcome: "skipped" });
  });

  it("a first failure after a quiet gap marks nothing and says nothing; the second, on the retry, reads Error and alerts", async () => {
    // An import held the PMS for three hours (every read skipped), then the
    // first read fails. Before the two-failure floor this marked Error and
    // paged on that one failure, before any retry.
    const w = world({ last_sync_at: iso(T0 - 180 * MIN) });
    const first = await readHealthAfterSync(w.client, H, "cloudbeds", { ok: false, error: "503" }, { nowMs: T0, alert: w.alert });
    expect(first).toMatchObject({ outcome: "failed", health: { failures: 1, minutesSinceGoodRead: 180, alert: null, markedError: false } });
    expect(w.connection().status).toBe("connected");
    expect(w.alerts).toEqual([]);
    expect(w.events()).toEqual([]);
    w.release(false);

    // Ten minutes on, the retry fails too: now it is the reads' own outage.
    const second = await readHealthAfterSync(w.client, H, "cloudbeds", { ok: false, error: "503" }, { nowMs: T0 + 10 * MIN, alert: w.alert });
    expect(second).toMatchObject({ outcome: "failed", health: { failures: 2, minutesSinceGoodRead: 190, alert: { sent: true }, markedError: true } });
    expect(w.connection().status).toBe("error");
    expect(w.events()).toEqual(["pms.reads_failing"]);
    expect(w.alerts[0].detail).toMatch(/^No good read for 190 minutes; 2 failed reads in a row\./);
    w.release(false);

    // The next read works: Connected again, one recovery line.
    w.goodRead(T0 + 25 * MIN);
    expect(await readHealthAfterSync(w.client, H, "cloudbeds", { ok: true }, { recover: w.recover })).toEqual({ outcome: "recovered", failures: 2, recovery: { sent: true } });
    expect(w.connection().status).toBe("connected");
  });

  it("with no good read on record, alerts at the third failure and reads Error at the sixth", async () => {
    const w = world({ last_sync_at: null });
    const failures: number[] = [];
    for (let n = 1; n <= 6; n++) {
      const out = await noteReadFailure(w.client, H, "cloudbeds", "unavailable", { nowMs: T0 + n * 10 * MIN, alert: w.alert });
      failures.push(out!.failures);
      w.release(false);
      if (n < READ_FAILURES_BEFORE_ALERT) expect(out!.alert).toBeNull();
      if (n >= READ_FAILURES_BEFORE_ALERT) expect(out!.alert).toEqual({ sent: true });
      expect(out!.minutesSinceGoodRead).toBeNull();
      expect(w.connection().status).toBe(n < 6 ? "connected" : "error");
    }
    expect(failures).toEqual([1, 2, 3, 4, 5, 6]);
    expect(w.alerts[0].detail).toMatch(/^No good read yet; 3 failed reads in a row/);
  });

  it("marks Error from Degraded too, never from Pending or Disconnected, and leaves an Error connection as it is", async () => {
    for (const [status, expected, marked] of [
      ["degraded", "error", true],
      ["pending", "pending", false],
      ["disconnected", "disconnected", false],
      ["error", "error", false],
    ] as const) {
      // The second failure in a row, two hours after the last good read.
      const w = world({ status, sync_failures: 1, last_sync_at: iso(T0 - 2 * READ_FAILING_ERROR_AFTER_MS) });
      const out = await noteReadFailure(w.client, H, "cloudbeds", "down", { nowMs: T0, alert: w.alert });
      expect(out?.markedError, status).toBe(marked);
      expect(w.connection().status, status).toBe(expected);
    }
    // The first failure in a row after the same gap marks nothing, whatever the status.
    const first = world({ status: "degraded", sync_failures: 0, last_sync_at: iso(T0 - 2 * READ_FAILING_ERROR_AFTER_MS) });
    expect(await noteReadFailure(first.client, H, "cloudbeds", "down", { nowMs: T0, alert: first.alert })).toMatchObject({ failures: 1, markedError: false, alert: null });
    expect(first.connection().status).toBe("degraded");
  });

  it("never throws: a connection that cannot be read is logged and the sync goes on", async () => {
    const w = world();
    const broken = fakeSupabase({ pms_connections: [] }, { fault: (c) => (c.table === "pms_connections" ? { message: "statement timeout" } : null) });
    expect(await noteReadFailure(broken.client, H, "cloudbeds", "down", { nowMs: T0, alert: w.alert })).toBeNull();
    expect(await noteReadRecovered(broken.client, H, "cloudbeds", { recover: w.recover })).toBeNull();
    expect(await readHealthAfterSync(broken.client, H, "cloudbeds", { ok: false, error: "down" }, { alert: w.alert })).toEqual({ outcome: "failed", health: null });
    // No connection row: nothing to count.
    const none = fakeSupabase({ pms_connections: [] });
    expect(await noteReadFailure(none.client, H, "cloudbeds", "down", { nowMs: T0, alert: w.alert })).toBeNull();
  });

  it("uses the thresholds the decision named", () => {
    expect(READ_FAILURES_BEFORE_ALERT).toBe(3);
    expect(READ_FAILING_ALERT_AFTER_MS).toBe(30 * MIN);
    expect(READ_FAILING_ERROR_AFTER_MS).toBe(60 * MIN);
    // The clocks count once the streak is the reads' own: two failures in a row.
    expect(READ_FAILURES_BEFORE_CLOCK).toBe(2);
  });
});

describe("the recovery line", () => {
  const key = readsFailingAlertKey("cloudbeds", H);
  const posted: string[] = [];
  beforeEach(() => {
    posted.length = 0;
    vi.stubEnv("MAYA_ALERT_WEBHOOK", "https://hooks.example.test/maya");
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      posted.push(String(JSON.parse(init.body).text));
      return { ok: true, status: 200 } as Response;
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("is posted once per alert that went out, and not for a condition the channel never heard of", async () => {
    const db = fakeSupabase({ platform_audit_events: [] });
    const recovery = { key, title: "cloudbeds reads are working again", detail: "3 failed reads in a row before this one.", hotelId: H };
    // Nothing was ever raised: nothing to recover from.
    expect(await raiseRecovery(db.client, recovery)).toEqual({ sent: false, reason: "nothing_to_recover" });
    expect(posted).toEqual([]);

    db.tables.platform_audit_events.push({ event_type: "alert.raised", entity_id: key, created_at: iso(T0) });
    expect(await raiseRecovery(db.client, recovery)).toEqual({ sent: true });
    expect(posted).toEqual([`🟢 *MAYA recovered* — cloudbeds reads are working again\n> 3 failed reads in a row before this one.\n> hotel \`${H}\``]);
    // The recovery is on record, so a second good read says nothing more.
    const logged = db.tables.platform_audit_events.filter((e) => e.event_type === "alert.recovered");
    expect(logged).toHaveLength(0); // the fake's rpc does not write; the call is what is checked
    expect(db.calls.filter((c) => c.table === "rpc:platform_log_event").map((c) => (c.payload as { p_event_type: string }).p_event_type)).toEqual(["alert.recovered"]);
  });

  it("says nothing without a webhook, and nothing again after the last recovery", async () => {
    vi.stubEnv("MAYA_ALERT_WEBHOOK", "");
    const db = fakeSupabase({ platform_audit_events: [{ event_type: "alert.raised", entity_id: key, created_at: iso(T0) }] });
    expect(await raiseRecovery(db.client, { key, title: "t" })).toEqual({ sent: false, reason: "no_webhook_configured" });

    vi.stubEnv("MAYA_ALERT_WEBHOOK", "https://hooks.example.test/maya");
    db.tables.platform_audit_events.push({ event_type: "alert.recovered", entity_id: key, created_at: iso(T0 + MIN) });
    expect(await raiseRecovery(db.client, { key, title: "t" })).toEqual({ sent: false, reason: "already_recovered" });
    // Raised again after that recovery: a new streak, a new line.
    db.tables.platform_audit_events.push({ event_type: "alert.raised", entity_id: key, created_at: iso(T0 + 2 * MIN) });
    expect(await raiseRecovery(db.client, { key, title: "t" })).toEqual({ sent: true });
    expect(posted).toHaveLength(1);
  });
});
