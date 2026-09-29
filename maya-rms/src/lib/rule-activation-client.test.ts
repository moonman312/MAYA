/**
 * The popup's calendar and words: a month block for every month the pricing
 * window reaches, the parts a preview is asked in, the count's sentence,
 * and the days as runs for screen readers.
 */
import { describe, expect, it } from "vitest";
import { addDays, affectedSentence, dateRanges, dayTitle, draftKind, monthBlocks, previewParts } from "./rule-activation-client";

describe("the popup's calendar", () => {
  it("a 396-night window from 1 October 2026 is thirteen months, the last partly outside it", () => {
    const blocks = monthBlocks("2026-10-01", addDays("2026-10-01", 395));
    expect(blocks.map((b) => b.label)).toEqual([
      "Oct 2026", "Nov", "Dec", "Jan 2027", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct",
    ]);
    expect(blocks.flatMap((b) => b.days).filter((d) => d.inWindow)).toHaveLength(396);
  });

  it("from mid-month the first and last months are both partly outside it, fourteen in all", () => {
    const blocks = monthBlocks("2026-09-29", addDays("2026-09-29", 395));
    expect(blocks).toHaveLength(14);
    expect(blocks[0].days.filter((d) => d.inWindow).map((d) => d.date)).toEqual(["2026-09-29", "2026-09-30"]);
    expect(blocks[13].days.filter((d) => d.inWindow)).toHaveLength(29);
    // Sunday first, as the Calendar tab: 1 September 2026 is a Tuesday.
    expect(blocks[0].lead).toBe(2);
  });
});

describe("the words", () => {
  it("counts days, one day as one day", () => {
    expect(affectedSentence(0)).toBe("0 days will be affected by this rule.");
    expect(affectedSentence(1)).toBe("1 day will be affected by this rule.");
    expect(affectedSentence(41)).toBe("41 days will be affected by this rule.");
  });

  it("reads runs of days out whole", () => {
    expect(dateRanges(["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-10"])).toBe(
      "28 September to 2 October 2026, 10 October 2026",
    );
    expect(dateRanges(["2026-12-31", "2027-01-01"])).toBe("31 December 2026 to 1 January 2027");
    expect(dateRanges(["2026-10-03", "2026-10-04"])).toBe("3 to 4 October 2026");
  });

  it("a day's hover names the day and the room types", () => {
    expect(dayTitle("2026-10-03", 1)).toBe("Sat 3 Oct 2026: prices change on 1 room type");
    expect(dayTitle("2026-10-03", undefined)).toBe("Sat 3 Oct 2026");
  });

  it("no em dashes anywhere in them", () => {
    for (const s of [affectedSentence(2), dateRanges(["2026-10-01"]), dayTitle("2026-10-01", 2)]) expect(s).not.toMatch(/—/);
  });
});

describe("how a preview is asked", () => {
  it("a standard rule in one request, a booking speed or pickup rule in three, nearest first", () => {
    expect(previewParts("standard", "2026-10-01")).toEqual([{}]);
    expect(previewParts("event", "2026-10-01")).toEqual([
      { to: "2026-11-29" },
      { from: "2026-11-30", to: "2027-03-29" },
      { from: "2027-03-30" },
    ]);
  });

  it("tells the kinds apart from a draft or a saved rule's conditions", () => {
    expect(draftKind({ condition: { occupancy_operator: "gt" } })).toBe("standard");
    expect(draftKind({ condition: { booking_speed_operator: "at_least" } })).toBe("event");
    expect(draftKind(undefined, { pickup_rate: ">2" })).toBe("event");
  });
});
