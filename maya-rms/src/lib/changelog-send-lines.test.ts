/**
 * A live change says a price was sent only when the send ledger shows it,
 * and only for the price the night has now, judged by which run wrote the
 * night's newest audit row; the rest say waiting, couldn't be sent or held
 * back, or nothing at all, and never waiting when the push can't send. A
 * simulated change still the night's price on a property live now says what
 * became of it after going live. MAYA's overwrites of a rate changed in the
 * property system follow the same ledger.
 */
import { describe, expect, it } from "vitest";
import { fakeSupabase } from "@/lib/engine/fake-supabase.test";
import {
  afterLiveState,
  attachSendLines as attach,
  cellKey,
  liveCells,
  nightSendState,
  overwriteSendState,
  readSendFacts,
  type SendFacts,
} from "./changelog-send-lines";
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

/** The night's newest audit row was written by the run at 11:00 (the default cycle's). */
const NEWEST = new Map([[cellKey("2026-11-13", "rt-1"), Date.parse("2026-10-01T11:00:00Z")]]);
const attachSendLines = (items: ChangelogCycle[], f: SendFacts, newest: ReadonlyMap<string, number> | null = NEWEST) =>
  attach(items, f, newest);

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
    // The older one did not write the night's newest row: no line either, sent or not.
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

  it("asks the ledger only about live nights, each once, and simulated ones too once the property is live", () => {
    const items = [cycle([entry(), entry({ mode: "simulation", stay_date: "2026-11-20" })]), cycle([entry()], "2026-10-01T10:00:00Z")];
    expect(liveCells(items)).toEqual([{ stay_date: "2026-11-13", room_type_id: "rt-1" }]);
    expect(liveCells(items, true)).toEqual([
      { stay_date: "2026-11-13", room_type_id: "rt-1" },
      { stay_date: "2026-11-20", room_type_id: "rt-1" },
    ]);
  });

  it("goes by which run wrote the night's newest row, not by what is shown", () => {
    // Run 14 set $165; a later run, not on this page, set something else and a
    // later one $165 again. Run 14 is the newest change shown, but not the
    // night's newest row: the ledger's send is the later run's, not its.
    const later = new Map([[cellKey("2026-11-13", "rt-1"), Date.parse("2026-10-01T11:30:00Z")]]);
    expect(lineOf(attachSendLines([cycle([entry()])], facts(), later)).send_line).toBeUndefined();
    expect(lineOf(attachSendLines([cycle([entry()])], facts({ ledger: new Map() }), later)).send_line).toBeUndefined();
    // Without the newest rows nothing claims a send; Mews needs no ledger.
    expect(lineOf(attachSendLines([cycle([entry()])], facts(), null)).send_line).toBeUndefined();
    expect(lineOf(attachSendLines([cycle([entry()])], facts({ pmsType: "mews" }), null)).send_state).toBe("not_sent");
  });

  it("never says waiting while the push can't send, or for a night past its window", () => {
    const unsent = { ledger: new Map() };
    expect(lineOf(attachSendLines([cycle([entry()])], facts({ ...unsent, canSend: false }))).send_line).toBeUndefined();
    expect(lineOf(attachSendLines([cycle([entry()])], facts({ ...unsent, lastNight: "2026-11-12" }))).send_line).toBeUndefined();
    expect(lineOf(attachSendLines([cycle([entry()])], facts({ ...unsent, canSend: true, lastNight: "2026-11-13" }))).send_state).toBe("waiting");
    // What the ledger shows already happened stays true either way.
    expect(lineOf(attachSendLines([cycle([entry()])], facts({ canSend: false }))).send_state).toBe("sent");
  });

  it("adds what became of a simulated price after going live, only while it is the night's price", () => {
    const sim = entry({ mode: "simulation", send_state: "simulated", send_line: "Nothing was sent to Cloudbeds at the time." });
    const simCycle = (changes: ChangelogEntry[]) => ({ ...cycle(changes), mode: "simulation" as const });
    // Sent at 11:59, after the simulated run at 11:00.
    expect(lineOf(attachSendLines([simCycle([sim])], facts({ liveNow: true })))).toMatchObject({
      send_line: "Nothing was sent to Cloudbeds at the time.",
      send_after_state: "sent",
      send_after_line: "Sent to Cloudbeds after you went live.",
    });
    expect(lineOf(attachSendLines([simCycle([sim])], facts({ liveNow: true, ledger: new Map() }))).send_after_line).toBe(
      "Waiting to be sent to Cloudbeds now that you're live.",
    );
    // Still simulating, replaced by a later row, or another price now: nothing added.
    expect(lineOf(attachSendLines([simCycle([sim])], facts({ liveNow: false }))).send_after_line).toBeUndefined();
    const later = new Map([[cellKey("2026-11-13", "rt-1"), Date.parse("2026-10-01T11:30:00Z")]]);
    expect(lineOf(attachSendLines([simCycle([sim])], facts({ liveNow: true }), later)).send_after_line).toBeUndefined();
    expect(lineOf(attachSendLines([simCycle([entry({ ...sim, new_rate: 170 })])], facts({ liveNow: true }))).send_after_line).toBeUndefined();
    // A send at that price from before the simulated run is not about it.
    const early = facts({ liveNow: true, ledger: new Map([[cellKey("2026-11-13", "rt-1"), ledger({ pushedAtMs: Date.parse("2026-10-01T10:00:00Z") })]]) });
    expect(lineOf(attachSendLines([simCycle([sim])], early)).send_after_line).toBeUndefined();
    // Mews: nothing goes there, live or not.
    expect(lineOf(attachSendLines([simCycle([sim])], facts({ liveNow: true, pmsType: "mews" }))).send_after_line).toBeUndefined();
  });
});

describe("afterLiveState", () => {
  const night = { stay_date: "2026-11-13", room_type_id: "rt-1", price: 165 };
  it("reads the ledger only once live, and only a send after the simulated moment", () => {
    const at = Date.parse("2026-10-01T11:00:00Z");
    expect(afterLiveState(night, at, facts({ liveNow: true }))).toBe("sent");
    expect(afterLiveState(night, at, facts())).toBeNull();
    expect(afterLiveState(night, NOW, facts({ liveNow: true }))).toBeNull();
  });
});

describe("readSendFacts", () => {
  const HOTEL = "hotel-1";
  const cells = [{ stay_date: "2026-11-13", room_type_id: "rt-1" }];
  const failedRow = {
    hotel_id: HOTEL,
    room_type_id: "rt-1",
    stay_date: "2026-11-13",
    status: "failed",
    price: 165,
    // A held cause: retried only when let through.
    error: "Cloudbeds patchRate failed (401): Unauthorized",
    attempts: 5,
    pms_job_reference: null,
    pushed_at: "2026-10-01T11:58:00Z",
  };
  const seed = (row: Record<string, unknown>, conn: Record<string, unknown> = {}) => ({
    rate_updates: [row],
    published_price: [{ hotel_id: HOTEL, room_type_id: "rt-1", stay_date: "2026-11-13", price: 165 }],
    hotel_settings: [{ hotel_id: HOTEL, simulation_mode: false }],
    pms_connections: [{ hotel_id: HOTEL, pms_type: "cloudbeds", status: "connected", ...conn }],
  });
  const read = (s: ReturnType<typeof seed>) =>
    readSendFacts(fakeSupabase(s).client, { hotelId: HOTEL, pmsType: "cloudbeds", today: "2026-10-01", now: new Date(NOW) }, cells);
  const night = { stay_date: "2026-11-13", room_type_id: "rt-1", price: 165 };

  it("says couldn't be sent for a failure MAYA has stopped retrying", async () => {
    expect(nightSendState(night, await read(seed(failedRow)))).toBe("failed");
  });

  it("says waiting once Try again was pressed after the last try, as the push will send it", async () => {
    const facts = await read(seed({ ...failedRow, retry_requested_at: "2026-10-01T11:59:00Z" }));
    expect(facts.ledger.get(cellKey("2026-11-13", "rt-1"))?.retryRequestedAtMs).toBe(Date.parse("2026-10-01T11:59:00Z"));
    expect(nightSendState(night, facts)).toBe("waiting");
  });

  it("says waiting once the connection was authorised again after the last try", async () => {
    const facts = await read(seed(failedRow, { reauthorized_at: "2026-10-01T11:59:00Z" }));
    expect(nightSendState(night, facts)).toBe("waiting");
  });

  it("reads the push's gates: back in simulation, paused or disconnected means not waiting", async () => {
    const unsent = { ...failedRow, status: "sent", price: 150, error: null, attempts: 1 };
    expect(nightSendState(night, await read(seed(unsent)))).toBe("waiting");
    const sim = { ...seed(unsent), hotel_settings: [{ hotel_id: HOTEL, simulation_mode: true }] };
    expect(nightSendState(night, await read(sim))).toBeNull();
    const paused = { ...seed(unsent), hotel_subscriptions: [{ hotel_id: HOTEL, status: "canceled" }] };
    expect(nightSendState(night, await read(paused as ReturnType<typeof seed>))).toBeNull();
    expect(nightSendState(night, await read(seed(unsent, { status: "disconnected" })))).toBeNull();
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
