/**
 * The words the Pilot health page says about a property: each problem rule,
 * how far the daily pass has priced, and that "today" is the hotel's day.
 */
import { describe, expect, it } from "vitest";
import {
  ageLabel,
  assessProperty,
  compareAssessed,
  humaniseCause,
  pricedThroughOf,
  type PilotHealthRow,
} from "./pilot-health-assess";

/** Mid-afternoon in London, evening in Auckland. */
const NOW = "2026-09-29T15:00:00Z";
const minutesAgo = (n: number, now = NOW) => new Date(Date.parse(now) - n * 60_000).toISOString();

/** A property with nothing wrong: read a moment ago, today's pass done, queue empty. */
function healthy(o: Partial<PilotHealthRow> = {}): PilotHealthRow {
  return {
    hotel_id: "hotel-1",
    name: "Harbour Inn",
    timezone: "UTC",
    is_test: false,
    mode: "live",
    subscription_status: "active",
    pms_type: "mews",
    pms_status: "connected",
    last_sync_at: minutesAgo(4),
    down_since: null,
    sync_failures: 0,
    last_ok_run_at: minutesAgo(2),
    pass_date: "2026-09-29",
    pass_cursor: null,
    pass_started_at: minutesAgo(600),
    pass_completed_at: minutesAgo(580),
    pass_horizon_days: 396,
    dirty_count: 0,
    dirty_oldest_marked_at: null,
    sent_24h: 12,
    open_incidents: 0,
    open_incidents_since: null,
    open_incidents_admin_only: 0,
    open_incident_causes: [],
    active_rules: 3,
    rule_changes_24h: 0,
    ...o,
  };
}

const texts = (row: PilotHealthRow, now = NOW) => assessProperty(row, now).problems.map((p) => p.text);

describe("assessProperty", () => {
  it("finds nothing wrong with a healthy property and says how far it is priced", () => {
    const a = assessProperty(healthy(), NOW);
    expect(a.problems).toEqual([]);
    expect(a.worst).toBeNull();
    expect(a.today).toBe("2026-09-29");
    expect(a.pricedThrough).toEqual({ kind: "done", date: "2027-10-29" });
    expect(a.pricedThroughText).toBe("Priced through 2027-10-29");
  });

  it("names a connection in Error or Disconnected, and since when", () => {
    expect(texts(healthy({ pms_status: "error", down_since: minutesAgo(180), last_sync_at: minutesAgo(180) }))).toEqual([
      "The connection has been in Error for 3h.",
      "No successful read for 3h.",
    ]);
    expect(texts(healthy({ pms_status: "disconnected", down_since: minutesAgo(3 * 24 * 60) }))).toContain(
      "The connection has been Disconnected for 3d.",
    );
    expect(texts(healthy({ pms_status: "error" }))).toContain("The connection is in Error.");
    const a = assessProperty(healthy({ pms_status: "error" }), NOW);
    expect(a.problems[0]).toMatchObject({ kind: "connection", severity: "rose" });
  });

  it("flags no successful read in 30 minutes, or never, unless the connection is still pending", () => {
    expect(texts(healthy({ last_sync_at: minutesAgo(29) }))).toEqual([]);
    expect(texts(healthy({ last_sync_at: minutesAgo(31) }))).toEqual(["No successful read for 31m."]);
    expect(texts(healthy({ last_sync_at: null }))).toEqual(["MAYA has never read from this system."]);
    expect(texts(healthy({ last_sync_at: null, pms_status: "pending" }))).toEqual([]);
    expect(texts(healthy({ last_sync_at: null, pms_status: null, pms_type: null }))).toEqual([
      "No property system is connected, so nothing is read.",
    ]);
  });

  it("flags a daily pass not started today, as a note early in the hotel day and a problem later", () => {
    // 15:00 UTC is 15h into a UTC hotel's day.
    const late = assessProperty(healthy({ pass_date: "2026-09-28" }), NOW);
    expect(late.problems).toEqual([
      {
        kind: "pass",
        severity: "rose",
        text: "Today's pass has not started, 15h into the hotel day. The last pass, for 2026-09-28, priced through 2027-10-28.",
      },
    ]);
    expect(late.pricedThroughText).toBe("Not started today; the 2026-09-28 pass priced through 2027-10-28");

    // 00:30 UTC: the pass has half an hour of the hotel day behind it.
    const earlyNow = "2026-09-29T00:30:00Z";
    const early = assessProperty(
      healthy({ pass_date: "2026-09-28", last_sync_at: minutesAgo(2, earlyNow), pass_completed_at: null }),
      earlyNow,
    );
    expect(early.problems).toEqual([
      {
        kind: "pass",
        severity: "amber",
        text: "Today's pass has not started, 30m into the hotel day. The last pass, for 2026-09-28, priced nothing.",
      },
    ]);
    expect(early.worst).toBe("amber");
  });

  it("leaves a pass alone while it runs as a healthy one does, however late in the hotel day it started", () => {
    // An owner's edit at 3 pm starts a new pass; a few ticks later it is done.
    const a = assessProperty(
      healthy({ pass_cursor: "2026-11-03", pass_completed_at: null, pass_started_at: minutesAgo(20) }),
      NOW,
    );
    expect(a.pricedThrough).toEqual({ kind: "running", date: "2026-11-02" });
    expect(a.pricedThroughText).toBe("Priced through 2026-11-02 so far, pass running");
    expect(a.problems).toEqual([]);
    expect(a.worst).toBeNull();
  });

  it("says how far a running pass has got, and when it started, once it has run long or stopped pricing", () => {
    const a = assessProperty(
      healthy({ pass_cursor: "2026-11-03", pass_completed_at: null, pass_started_at: minutesAgo(45) }),
      NOW,
    );
    expect(a.problems).toEqual([
      { kind: "pass", severity: "rose", text: "Today's pass started 45m ago and is still running, priced through 2026-11-02 so far." },
    ]);

    const stalled = assessProperty(
      healthy({ pass_cursor: "2026-11-03", pass_completed_at: null, pass_started_at: minutesAgo(10), last_ok_run_at: minutesAgo(40) }),
      NOW,
    );
    expect(stalled.problems).toEqual([
      {
        kind: "pass",
        severity: "rose",
        text: "Today's pass started 10m ago and is still running, priced through 2026-11-02 so far. Nothing has priced without an error for 40m.",
      },
    ]);

    const fresh = assessProperty(
      healthy({ pass_cursor: "2026-09-29", pass_completed_at: null, pass_started_at: null }),
      "2026-09-29T00:10:00Z",
    );
    expect(fresh.pricedThroughText).toBe("Pass running, nothing priced yet");
    expect(fresh.problems.map((p) => [p.severity, p.text])).toEqual([
      ["amber", "Today's pass is still running, has priced nothing yet."],
    ]);
  });

  it("says when pricing has never run", () => {
    const a = assessProperty(healthy({ pass_date: null, pass_completed_at: null, pass_started_at: null, pass_horizon_days: null }), NOW);
    expect(a.pricedThroughText).toBe("Never run");
    expect(a.problems).toEqual([{ kind: "pass", severity: "rose", text: "Pricing has never run." }]);
  });

  it("names the causes of open sending problems, and leaves MAYA's own holds out of them", () => {
    expect(
      texts(
        healthy({
          open_incidents: 2,
          open_incidents_since: minutesAgo(180),
          open_incident_causes: ["rate_not_found", "vendor_busy"],
          open_incidents_admin_only: 1,
        }),
      ),
    ).toEqual(["2 open sending problems for 3h: rate not found, vendor busy."]);
    expect(texts(healthy({ open_incidents: 1, open_incident_causes: ["rate_not_found"] }))).toEqual([
      "1 open sending problem: rate not found.",
    ]);
    expect(texts(healthy({ open_incidents_admin_only: 2 }))).toEqual([]);
  });

  it("flags a queue that is not draining, but not one that was touched a moment ago", () => {
    expect(texts(healthy({ dirty_count: 3, dirty_oldest_marked_at: minutesAgo(45) }))).toEqual([
      "3 nights waiting to be priced, the oldest for 45m.",
    ]);
    expect(texts(healthy({ dirty_count: 1, dirty_oldest_marked_at: minutesAgo(31) }))).toEqual([
      "1 night waiting to be priced, the oldest for 31m.",
    ]);
    expect(texts(healthy({ dirty_count: 40, dirty_oldest_marked_at: minutesAgo(5) }))).toEqual([]);
  });

  it("counts today by the hotel's clock: the same pass is done in London and stale in Auckland", () => {
    // 11:30 UTC on 29 September is 12:30 in London and 00:30 on the 30th in Auckland.
    const now = "2026-09-29T11:30:00Z";
    const row = healthy({ pass_date: "2026-09-29", last_sync_at: minutesAgo(1, now) });
    const london = assessProperty({ ...row, timezone: "Europe/London" }, now);
    expect(london.today).toBe("2026-09-29");
    expect(london.problems).toEqual([]);
    expect(london.pricedThrough).toEqual({ kind: "done", date: "2027-10-29" });

    const auckland = assessProperty({ ...row, timezone: "Pacific/Auckland" }, now);
    expect(auckland.today).toBe("2026-09-30");
    expect(auckland.pricedThrough).toEqual({ kind: "stale", passDate: "2026-09-29", date: "2027-10-29" });
    expect(auckland.problems).toEqual([
      {
        kind: "pass",
        severity: "amber",
        text: "Today's pass has not started, 30m into the hotel day. The last pass, for 2026-09-29, priced through 2027-10-29.",
      },
    ]);
  });

  it("uses no em dash in anything it says", () => {
    const rows = [
      healthy({ pms_status: "error", down_since: minutesAgo(5), last_sync_at: null, pass_date: null, dirty_count: 2, dirty_oldest_marked_at: minutesAgo(90), open_incidents: 1, open_incident_causes: ["unknown"] }),
      healthy({ pass_cursor: "2026-10-05", pass_completed_at: null }),
      healthy({ pass_date: "2026-09-27" }),
    ];
    for (const row of rows) {
      const a = assessProperty(row, NOW);
      expect(a.pricedThroughText).not.toContain("—");
      for (const p of a.problems) expect(p.text).not.toContain("—");
    }
  });
});

describe("pricedThroughOf", () => {
  it("reads a finished pass, a running one, a stale one and none", () => {
    expect(pricedThroughOf(healthy(), "2026-09-29")).toEqual({ kind: "done", date: "2027-10-29" });
    expect(pricedThroughOf(healthy({ pass_horizon_days: 1 }), "2026-09-29")).toEqual({ kind: "done", date: "2026-09-29" });
    expect(pricedThroughOf(healthy({ pass_cursor: "2026-10-10", pass_completed_at: null }), "2026-09-29")).toEqual({
      kind: "running",
      date: "2026-10-09",
    });
    expect(pricedThroughOf(healthy({ pass_cursor: null, pass_completed_at: null }), "2026-09-29")).toEqual({ kind: "running", date: null });
    expect(pricedThroughOf(healthy({ pass_date: "2026-09-28", pass_cursor: "2026-10-01", pass_completed_at: null }), "2026-09-29")).toEqual({
      kind: "stale",
      passDate: "2026-09-28",
      date: "2026-09-30",
    });
    expect(pricedThroughOf(healthy({ pass_date: null }), "2026-09-29")).toEqual({ kind: "never" });
  });
});

describe("compareAssessed", () => {
  it("puts the properties with problems first, the worse first, then by name", () => {
    const entries = [
      healthy({ name: "Calm Inn" }),
      healthy({ name: "Busy Inn", pass_cursor: "2026-10-02", pass_completed_at: null }),
      healthy({ name: "Down Inn", pms_status: "error" }),
      healthy({ name: "Also Down Inn", pms_status: "error" }),
    ]
      .map((row) => ({ row, assessment: assessProperty(row, "2026-09-29T00:30:00Z") }))
      .sort(compareAssessed);
    expect(entries.map((e) => e.row.name)).toEqual(["Also Down Inn", "Down Inn", "Busy Inn", "Calm Inn"]);
  });
});

describe("ageLabel and humaniseCause", () => {
  it("say a duration the short way", () => {
    expect(ageLabel(minutesAgo(0), NOW)).toBe("under a minute");
    expect(ageLabel(minutesAgo(7), NOW)).toBe("7m");
    expect(ageLabel(minutesAgo(150), NOW)).toBe("3h");
    expect(ageLabel(minutesAgo(3 * 24 * 60), NOW)).toBe("3d");
    expect(humaniseCause("rate_not_found")).toBe("rate not found");
  });
});
