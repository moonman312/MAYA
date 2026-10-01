/**
 * A live change says a price was sent only when the send ledger shows it,
 * and only for the price the night has now; the rest say waiting, couldn't
 * be sent or held back, or nothing at all. MAYA's overwrites of a rate
 * changed in the property system follow the same ledger.
 */
import { describe, expect, it } from "vitest";
import { attachSendLines, cellKey, liveCells, nightSendState, overwriteSendState, type SendFacts } from "./changelog-send-lines";
import type { LedgerCell } from "./pms/send-status";
import type { ChangelogCycle, ChangelogEntry } from "@/types/domain";

const NOW = Date.parse("2026-10-01T12:00:00Z");

function entry(o: Partial<ChangelogEntry> = {}): ChangelogEntry {
  return {
    room_type: "Queen",
    rule_name: "Busy nights",
    original_rate: 150,
    new_rate: 165,
    change_pct: 10,
    occupancy_pct: 82,
    description: "",
    stay_date: "2026-11-13",
    room_type_id: "rt-1",
    mode: "live",
    ...o,
  };
}

function cycle(changes: ChangelogEntry[], at = "2026-10-01T11:00:00Z"): ChangelogCycle {
  return { cycle: 1, timestamp: at, has_changes: true, changes, mode: "live" };
}

function ledger(o: Partial<LedgerCell> = {}): LedgerCell {
  return { status: "sent", price: 165, error: null, attempts: 1, jobReference: "job-1", pushedAtMs: NOW - 60_000, retryRequestedAtMs: NaN, ...o };
}

function facts(o: Partial<SendFacts> = {}): SendFacts {
  return {
    pmsType: "cloudbeds",
    ledger: new Map([[cellKey("2026-11-13", "rt-1"), ledger()]]),
    published: new Map([[cellKey("2026-11-13", "rt-1"), 165]]),
    today: "2026-10-01",
    nowMs: NOW,
    ...o,
  };
}

const lineOf = (items: ChangelogCycle[], i = 0, j = 0) => items[i].changes[j];

describe("attachSendLines", () => {
  it("says sent when the ledger holds a send at the night's price", () => {
    expect(lineOf(attachSendLines([cycle([entry()])], facts()))).toMatchObject({ send_state: "sent", send_line: "Sent to Cloudbeds." });
  });

  it("says waiting when the push has not sent it yet, and couldn't be sent when it stopped trying", () => {
    const waiting = facts({ ledger: new Map() });
    expect(lineOf(attachSendLines([cycle([entry()])], waiting))).toMatchObject({ send_state: "waiting", send_line: "Waiting to be sent to Cloudbeds." });
    const older = facts({ ledger: new Map([[cellKey("2026-11-13", "rt-1"), ledger({ price: 150 })]]) });
    expect(lineOf(attachSendLines([cycle([entry()])], older)).send_state).toBe("waiting");
    // Refused by the PMS with its tries used: the push has stopped at this price.
    const refused = facts({
      ledger: new Map([[cellKey("2026-11-13", "rt-1"), ledger({ status: "failed", error: "Cloudbeds patchRate failed (400): Rate must be greater than 500", jobReference: null })]]),
    });
    expect(lineOf(attachSendLines([cycle([entry()])], refused))).toMatchObject({ send_state: "failed", send_line: "Couldn't be sent to Cloudbeds." });
    const held = facts({ ledger: new Map([[cellKey("2026-11-13", "rt-1"), ledger({ status: "skipped", error: "night has begun" })]]) });
    expect(lineOf(attachSendLines([cycle([entry()])], held))).toMatchObject({ send_state: "held", send_line: "Held back, not sent to Cloudbeds." });
  });

  it("says nothing for a price a later change replaced, or a night over and never sent", () => {
    const items = attachSendLines([cycle([entry({ new_rate: 170 })]), cycle([entry()], "2026-10-01T10:00:00Z")], facts());
    // The newest change's price is not the night's now (published says 165): no line.
    expect(items[0].changes[0].send_line).toBeUndefined();
    // The older one is not the newest shown for the night: no line either, sent or not.
    expect(items[1].changes[0].send_line).toBeUndefined();
    const over = attachSendLines([cycle([entry({ stay_date: "2026-09-29" })])], facts({ ledger: new Map(), published: new Map([[cellKey("2026-09-29", "rt-1"), 165]]) }));
    expect(over[0].changes[0].send_line).toBeUndefined();
  });

  it("says nothing goes to a system MAYA doesn't send prices to, on every live change", () => {
    const mews = attachSendLines([cycle([entry(), entry({ stay_date: "2026-11-14" })])], facts({ pmsType: "mews" }));
    expect(mews[0].changes.map((c) => c.send_line)).toEqual([
      "Nothing was sent to Mews. MAYA doesn't send prices there yet.",
      "Nothing was sent to Mews. MAYA doesn't send prices there yet.",
    ]);
  });

  it("leaves simulated changes, unknown ones, and a property with no connection as they are", () => {
    const sim = entry({ mode: "simulation", send_state: "simulated", send_line: "Nothing was sent to Cloudbeds." });
    const unknown = entry({ mode: undefined });
    const items = attachSendLines([cycle([sim, unknown])], facts());
    expect(items[0].changes[0]).toEqual(sim);
    expect(items[0].changes[1]).toEqual(unknown);
    expect(attachSendLines([cycle([entry()])], facts({ pmsType: null }))[0].changes[0].send_line).toBeUndefined();
  });

  it("asks the ledger only about live nights, each once", () => {
    expect(
      liveCells([cycle([entry(), entry({ mode: "simulation", stay_date: "2026-11-20" })]), cycle([entry()], "2026-10-01T10:00:00Z")]),
    ).toEqual([{ stay_date: "2026-11-13", room_type_id: "rt-1" }]);
  });
});

describe("overwriteSendState", () => {
  const notice = { stay_date: "2026-11-13", room_type_id: "rt-1", maya_price: 165, found_at: "2026-10-01T11:00:00Z" };

  it("says sent once a send at MAYA's price was made after the overwrite was found", () => {
    expect(overwriteSendState(notice, true, facts())).toBe("sent");
    // A send at that price from before the change in the PMS is not this one.
    const before = facts({ ledger: new Map([[cellKey("2026-11-13", "rt-1"), ledger({ pushedAtMs: Date.parse("2026-10-01T10:00:00Z") })]]) });
    expect(overwriteSendState(notice, true, before)).toBeNull();
  });

  it("says waiting while the ledger still holds the rate changed in the PMS", () => {
    const pmsRate = facts({ ledger: new Map([[cellKey("2026-11-13", "rt-1"), ledger({ price: 175, pushedAtMs: Date.parse(notice.found_at) })]]) });
    expect(overwriteSendState(notice, true, pmsRate)).toBe("waiting");
    // An older overwrite of the same night: the ledger no longer speaks for it.
    expect(overwriteSendState(notice, false, pmsRate)).toBeNull();
  });

  it("claims nothing where nothing is sent", () => {
    expect(overwriteSendState(notice, true, facts({ pmsType: "mews" }))).toBeNull();
  });
});

describe("nightSendState", () => {
  const night = { stay_date: "2026-11-13", room_type_id: "rt-1", price: 165 };

  it("speaks only for the price the night has now", () => {
    expect(nightSendState(night, facts())).toBe("sent");
    expect(nightSendState({ ...night, price: 170 }, facts())).toBeNull();
    expect(nightSendState(night, facts({ ledger: new Map() }))).toBe("waiting");
  });

  it("says nothing where MAYA sends nothing, or without the night's price on record", () => {
    expect(nightSendState(night, facts({ pmsType: "mews" }))).toBeNull();
    expect(nightSendState(night, facts({ published: new Map() }))).toBeNull();
  });
});
