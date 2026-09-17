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
      [{ ...refused(0, "2026-09-20"), phase: "guardrail", outcome: "skipped", http_status: null, message: "no rate target for room type" }],
      "cloudbeds",
    );
    expect(line).toMatchObject({ label: "MAYA held them back", detail: null });
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
      retries_not_kept: 112,
    });
    expect(item.action).toContain("Cloudbeds");
    expect(JSON.stringify(item)).not.toMatch(/[—–]/);
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
  it("puts each problem among the pricing runs at the time it started", () => {
    const run = (minutes: number, cycle: number): ChangelogCycle => ({ cycle, timestamp: at(minutes), has_changes: false, changes: [] });
    const [problem] = buildPushProblems(
      [{ id: "inc-1", pms_type: "think", cause: "pms_unavailable", opened_at: at(7), attempt_count: 1, attempts_stored: 1, resolved_at: null, resolution: null }],
      [],
      [],
      new Map(),
    );
    const merged = mergeTimeline([run(10, 3), run(5, 2), run(0, 1)], [problem]);
    expect(merged.map((m) => ("kind" in m ? m.kind : m.cycle))).toEqual([3, "push_problem", 2, 1]);
  });
});
