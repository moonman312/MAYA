import { describe, expect, it } from "vitest";
import {
  modeAt,
  modeTimelineFrom,
  nightLabel,
  pmsLabel,
  pmsSendsPrices,
  priceMoveHeadline,
  sendLine,
  type SendState,
} from "./price-mode";

const rows = [
  // Out of order on purpose: the database's order is not relied on.
  { since: "2026-09-20T10:00:00Z", simulated: false, recorded_at: "2026-09-20T10:00:00Z" },
  { since: "-infinity", simulated: true, recorded_at: "2026-09-30T23:00:00Z" },
  { since: "2026-09-25T08:00:00Z", simulated: true, recorded_at: "2026-09-25T08:00:00Z" },
];

describe("modeAt", () => {
  const timeline = modeTimelineFrom(rows);

  it("reads the mode at the event's own time, so a simulated run stays simulated after going live", () => {
    expect(modeAt(timeline, "2026-09-01T00:00:00Z")).toBe("simulation");
    expect(modeAt(timeline, "2026-09-20T10:00:00Z")).toBe("live");
    expect(modeAt(timeline, "2026-09-22T00:00:00Z")).toBe("live");
    expect(modeAt(timeline, "2026-09-26T00:00:00Z")).toBe("simulation");
  });

  it("says unknown where the history says it can't tell, or has nothing", () => {
    const unknownStart = modeTimelineFrom([
      { since: "-infinity", simulated: null },
      { since: "2026-09-16T00:00:00Z", simulated: false },
    ]);
    expect(modeAt(unknownStart, "2026-09-01T00:00:00Z")).toBe("unknown");
    expect(modeAt(unknownStart, "2026-09-17T00:00:00Z")).toBe("live");
    expect(modeAt([], "2026-09-17T00:00:00Z")).toBe("unknown");
    expect(modeAt(undefined, "2026-09-17T00:00:00Z")).toBe("unknown");
    expect(modeAt(modeTimelineFrom([{ since: "2026-09-16T00:00:00Z", simulated: true }]), "2026-09-01T00:00:00Z")).toBe("unknown");
    expect(modeAt(timeline, "not a time")).toBe("unknown");
  });

  it("lets the later recorded row win at the same instant, as hotel_simulated_at does", () => {
    const tie = modeTimelineFrom([
      { since: "2026-09-20T10:00:00Z", simulated: true, recorded_at: "2026-09-30T00:00:00Z" },
      { since: "2026-09-20T10:00:00Z", simulated: false, recorded_at: "2026-09-20T10:00:00Z" },
    ]);
    expect(modeAt(tie, "2026-09-21T00:00:00Z")).toBe("simulation");
  });
});

describe("the words", () => {
  it("heads a simulated change with what would have happened, never that it moved", () => {
    const line = priceMoveHeadline({
      mode: "simulation",
      stayDate: "2026-11-13",
      roomType: "Queen",
      from: 150,
      to: 165,
      changePct: 10,
      currencySymbol: "$",
    });
    expect(line).toBe("Simulation: the price for Fri Nov 13, Queen would have gone from $150.00 to $165.00.");
    expect(
      priceMoveHeadline({ mode: "simulation", stayDate: "2026-11-13", roomType: "Queen", from: 160, to: 160, changePct: 0, currencySymbol: "€" }),
    ).toBe("Simulation: the price for Fri Nov 13, Queen would have been €160.00.");
  });

  it("heads a live change as the log always has, in the property's currency", () => {
    expect(
      priceMoveHeadline({ mode: "live", stayDate: "2026-11-13", roomType: "Standard", from: 150, to: 165, changePct: 10, currencySymbol: "€" }),
    ).toBe("Standard · stay 2026-11-13: €150.00 up to €165.00 (+10%)");
    expect(
      priceMoveHeadline({ mode: "unknown", stayDate: "2026-11-13", roomType: "Standard", from: 165, to: 150, changePct: -9.1, currencySymbol: "$" }),
    ).toBe("Standard · stay 2026-11-13: $165.00 down to $150.00 (-9.1%)");
  });

  it("says nothing was sent in simulation, and live only what the ledger shows", () => {
    expect(sendLine({ mode: "simulation", state: null, pmsType: "cloudbeds" })).toBe("Nothing was sent to Cloudbeds.");
    expect(sendLine({ mode: "simulation", state: "sent", pmsType: null })).toBe("Nothing was sent to your property system.");
    const live = (state: SendState | null, pmsType = "think") => sendLine({ mode: "live", state, pmsType });
    expect(live("sent")).toBe("Sent to Think Reservations.");
    expect(live("waiting")).toBe("Waiting to be sent to Think Reservations.");
    expect(live("failed")).toBe("Couldn't be sent to Think Reservations.");
    expect(live("held")).toBe("Held back, not sent to Think Reservations.");
    expect(live("not_sent", "mews")).toBe("Nothing was sent to Mews. MAYA doesn't send prices there yet.");
    expect(live(null)).toBeNull();
    expect(sendLine({ mode: "unknown", state: "sent", pmsType: "cloudbeds" })).toBeNull();
  });

  it("names nights and systems plainly, with no em dash anywhere", () => {
    expect(nightLabel("2026-11-13")).toBe("Fri Nov 13");
    expect(nightLabel("2027-01-01")).toBe("Fri Jan 1");
    expect(pmsLabel("cloudbeds")).toBe("Cloudbeds");
    expect(pmsLabel(null)).toBe("your property system");
    expect(pmsSendsPrices("cloudbeds")).toBe(true);
    expect(pmsSendsPrices("think")).toBe(true);
    expect(pmsSendsPrices("mews")).toBe(false);
    expect(pmsSendsPrices(null)).toBe(false);
    for (const s of ["sent", "waiting", "failed", "held", "not_sent"] as const) {
      expect(sendLine({ mode: "live", state: s, pmsType: "cloudbeds" })).not.toMatch(/—/);
    }
  });
});
