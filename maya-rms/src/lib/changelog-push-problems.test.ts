/**
 * A push problem is one change log item however many tries sit behind it, and
 * the tries read condensed: identical refusals are one line with a count.
 */
import { describe, expect, it } from "vitest";
import {
  buildPushProblems,
  condenseRetries,
  type IncidentAttemptForLog,
  mergeTimeline,
} from "./changelog-push-problems";
import type { ChangelogCycle } from "@/types/domain";

const at = (minutes: number) => new Date(Date.parse("2026-09-17T10:00:00Z") + minutes * 60_000).toISOString();

function refused(minutes: number, stayDate: string, roomTypeId = "rt-king"): IncidentAttemptForLog {
  return {
    incident_id: "inc-1",
    attempted_at: at(minutes),
    stay_date: stayDate,
    room_type_id: roomTypeId,
    phase: "send",
    outcome: "failed",
    http_status: 400,
    message: "Cloudbeds patchRate failed (400): Rate must be greater than 500",
  };
}

describe("condenseRetries", () => {
  it("reads dozens of identical refusals as one line with a count, time range and nights", () => {
    const attempts: IncidentAttemptForLog[] = [];
    for (let tick = 0; tick < 10; tick++) {
      for (const night of ["2026-09-20", "2026-09-21", "2026-09-22"]) attempts.push(refused(tick * 5, night));
    }
    attempts.push({ ...refused(55, "2026-09-20"), outcome: "landed", message: null, http_status: null });

    expect(condenseRetries(attempts, "cloudbeds")).toEqual([
      {
        first_at: at(0),
        last_at: at(45),
        count: 30,
        nights: 3,
        room_types: 1,
        outcome: "failed",
        label: "Cloudbeds refused them",
        detail: "Rate must be greater than 500",
      },
      { first_at: at(55), last_at: at(55), count: 1, nights: 1, room_types: 1, outcome: "landed", label: "Went through", detail: null },
    ]);
  });

  it("never shows a guardrail's reason code as the PMS's words", () => {
    const [line] = condenseRetries(
      [{ ...refused(0, "2026-09-20"), phase: "guardrail", outcome: "skipped", http_status: null, message: "guardrail:stale_price" }],
      "cloudbeds",
    );
    expect(line).toMatchObject({ label: "MAYA held them back", detail: null });
  });

  it("says a night with no rate to send to had nothing to send to, not that MAYA held it back", () => {
    const skip = { ...refused(0, "2026-09-20"), phase: "guardrail", outcome: "skipped", http_status: null, message: "no rate target for room type" };
    expect(condenseRetries([skip], "cloudbeds", "rate_plan_not_updatable")[0]).toMatchObject({ label: "Nothing to send to in Cloudbeds", detail: null });
    expect(condenseRetries([skip], "cloudbeds", "pms_unavailable")[0]).toMatchObject({ label: "Couldn't read the rates in Cloudbeds" });
  });
});

describe("buildPushProblems", () => {
  const names = new Map([
    ["rt-king", "Deluxe King"],
    ["rt-queen", "Queen"],
  ]);

  it("names the root cause and room types, counts nights, and says what to do while it lasts", () => {
    const [item] = buildPushProblems(
      [
        {
          id: "inc-1",
          pms_type: "cloudbeds",
          cause: "rate_plan_not_updatable",
          opened_at: at(0),
          attempt_count: 612,
          attempts_stored: 500,
          resolved_at: null,
          resolution: null,
        },
      ],
      [
        { incident_id: "inc-1", room_type_id: "rt-king", stay_date: "2026-09-20" },
        { incident_id: "inc-1", room_type_id: "rt-king", stay_date: "2026-09-21" },
        { incident_id: "inc-2", room_type_id: "rt-queen", stay_date: "2026-09-21" },
      ],
      [refused(0, "2026-09-20")],
      names,
    );
    expect(item).toMatchObject({
      kind: "push_problem",
      timestamp: at(0),
      pms: "Cloudbeds",
      title: "Cloudbeds won't let MAYA change Deluxe King rates because that rate follows another rate plan",
      nights: 2,
      room_types: ["Deluxe King"],
      status: "ongoing",
      attempts: 612,
      // One try was read; the rest are counted, not listed.
      retries_not_kept: 611,
    });
    expect(item.action).toContain("Cloudbeds");
    expect(JSON.stringify(item)).not.toMatch(/[—–]/);
  });

  it("counts only what is still failing while it lasts, and everything it touched once over", () => {
    const incident = { id: "inc-1", pms_type: "cloudbeds", cause: "missing_write_permission", opened_at: at(0), attempt_count: 90, attempts_stored: 90, resolved_at: null, resolution: null };
    const cells = [
      { incident_id: "inc-1", room_type_id: "rt-king", stay_date: "2026-09-01", state: "stopped" },
      { incident_id: "inc-1", room_type_id: "rt-queen", stay_date: "2026-09-02", state: "landed" },
      { incident_id: "inc-1", room_type_id: "rt-king", stay_date: "2026-09-20", state: "open" },
      { incident_id: "inc-1", room_type_id: "rt-king", stay_date: "2026-09-21", state: "open" },
    ];
    const [ongoing] = buildPushProblems([incident], cells, [], names);
    expect(ongoing).toMatchObject({ nights: 2, room_types: ["Deluxe King"] });
    expect(ongoing.title).not.toContain("Queen");

    const [over] = buildPushProblems([{ ...incident, resolved_at: at(60), resolution: "landed" }], cells, [], names);
    expect(over).toMatchObject({ nights: 4, room_types: ["Deluxe King", "Queen"] });
  });

  it("drops the advice once it is over", () => {
    const [item] = buildPushProblems(
      [
        {
          id: "inc-1",
          pms_type: "cloudbeds",
          cause: "value_rejected",
          opened_at: at(0),
          attempt_count: 2,
          attempts_stored: 2,
          resolved_at: at(30),
          resolution: "superseded",
        },
      ],
      [{ incident_id: "inc-1", room_type_id: "rt-king", stay_date: "2026-09-20" }],
      [],
      names,
    );
    expect(item).toMatchObject({ status: "resolved", resolved_at: at(30), resolution: "superseded", action: null });
  });
});

describe("mergeTimeline", () => {
  const run = (minutes: number, cycle: number): ChangelogCycle => ({ cycle, timestamp: at(minutes), has_changes: false, changes: [] });
  const problem = (id: string, openedAt: string, resolvedAt: string | null) =>
    buildPushProblems(
      [{ id, pms_type: "think", cause: "pms_unavailable", opened_at: openedAt, attempt_count: 1, attempts_stored: 1, resolved_at: resolvedAt, resolution: resolvedAt ? "landed" : null }],
      [],
      [],
      new Map(),
    )[0];

  it("puts an ongoing problem above every run, however long ago it opened", () => {
    const merged = mergeTimeline([run(130, 3), run(125, 2), run(120, 1)], [problem("inc-old", at(0), null), problem("inc-new", at(60), null)]);
    expect(merged.map((m) => ("kind" in m ? m.id : m.cycle))).toEqual(["inc-new", "inc-old", 3, 2, 1]);
  });

  it("puts a resolved problem where it ended, and leaves out one that ended before the oldest run shown", () => {
    const merged = mergeTimeline(
      [run(130, 3), run(125, 2), run(120, 1)],
      [problem("inc-ended", at(0), at(127)), problem("inc-history", at(0), at(30))],
    );
    expect(merged.map((m) => ("kind" in m ? m.id : m.cycle))).toEqual([3, "inc-ended", 2, 1]);
  });
});
