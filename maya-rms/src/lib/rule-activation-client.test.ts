/**
 * The popup's calendar and words: a month block for every month the pricing
 * window reaches, the parts a preview is asked in, the count's sentence,
 * and the days as runs for screen readers.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DAYS_NOT_CALCULATED,
  PREVIEW_PART_TIME_LIMIT_MS,
  addDays,
  affectedSentence,
  dateRanges,
  dayTitle,
  draftKind,
  farOutCutLines,
  fetchRulePreview,
  monthBlocks,
  previewParts,
  type PreviewOutcome,
} from "./rule-activation-client";

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
    // Nothing to change: the popup only turns the rule on (Jake, 2026-09-29).
    expect(affectedSentence(0)).toBe("0 prices will be affected by this rule.");
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

describe("a cut on low pickup with no booking window (A4)", () => {
  const facts = { threshold: 1, windowDays: 7, metric: "room_nights" as const, waitDays: 7 };

  it("says how far the rule reaches and that the cut repeats, in plain words", () => {
    const lines = farOutCutLines({ farOutCut: facts, reach: 396, horizonDays: 396 });
    expect(lines).toEqual([
      "With no booking window condition, this rule reaches 396 of the 396 nights ahead. A night that gained under 1 room night over the 7 full days before counts as quiet, and a far-out night with no bookings yet always will, once your rules have run for 1 week.",
      "The cut repeats: each time its wait of 1 week is over and the night is still quiet, it cuts again, on top of the cut before.",
    ]);
    // A revenue rule over a day, waiting two weeks, on a rule with a date window.
    const revenue = farOutCutLines({ farOutCut: { threshold: 500, windowDays: 1, metric: "revenue", waitDays: 14 }, reach: 120, horizonDays: 396 });
    expect(revenue[0]).toContain("reaches 120 of the 396 nights ahead");
    expect(revenue[0]).toContain("under 500 in revenue over the day before");
    expect(revenue[0]).toContain("once your rules have run for 1 day");
    expect(revenue[1]).toContain("its wait of 2 weeks is over");
    expect(farOutCutLines({ farOutCut: { ...facts, threshold: 3, windowDays: 3, waitDays: 3 }, reach: 1, horizonDays: 396 })[0]).toContain(
      "under 3 room nights over the 3 full days before",
    );
    for (const s of [...lines, ...revenue]) expect(s).not.toMatch(/—/);
  });

  it("nothing for any other rule", () => {
    expect(farOutCutLines({ farOutCut: null, reach: 10, horizonDays: 396 })).toEqual([]);
  });

  it("adds up the reach of every part and takes the facts from the answer", async () => {
    const impl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { from?: string; to?: string };
      const reach = !body.from ? 60 : body.to ? 120 : 216;
      const part = {
        needsActivation: true,
        today: "2026-10-01",
        lastNight: "2027-10-31",
        affected: [],
        touched: [],
        fingerprint: "fp",
        kind: "event",
        horizonDays: 396,
        reach,
        farOutCut: facts,
      };
      return new Response(JSON.stringify(part), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const outcome = await fetchRulePreview({ intent: "enable", ruleId: "r1" }, "event", () => {}, impl as unknown as typeof fetch, "2026-10-01");
    expect(outcome.status).toBe("ready");
    if (outcome.status !== "ready") return;
    expect(outcome.preview).toMatchObject({ reach: 396, horizonDays: 396, farOutCut: facts, parts: 3, done: 3 });
  });
});

describe("a preview that never answers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Ask for an event rule's three parts with `impl`, and read the outcome as the clock moves. */
  function ask(impl: (url: string, init?: RequestInit) => Promise<Response>) {
    const signals: AbortSignal[] = [];
    const answer: { outcome?: PreviewOutcome } = {};
    const tracked = (url: string, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      return impl(url, init);
    };
    void fetchRulePreview({ intent: "enable", ruleId: "r1" }, "event", () => {}, tracked as unknown as typeof fetch, "2026-10-01").then(
      (o) => (answer.outcome = o),
    );
    return { signals, answer };
  }

  it("gives up after the time limit with the can't-calculate line, and stops the requests", async () => {
    vi.useFakeTimers();
    // A stalled connection: the request never answers.
    const { signals, answer } = ask(() => new Promise<Response>(() => {}));
    // Longer than the server's own 60 seconds, so its time-out answers first when it can.
    expect(PREVIEW_PART_TIME_LIMIT_MS).toBeGreaterThan(60_000);
    await vi.advanceTimersByTimeAsync(PREVIEW_PART_TIME_LIMIT_MS - 1);
    expect(answer.outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(answer.outcome).toEqual({ status: "error", message: DAYS_NOT_CALCULATED });
    expect(signals).toHaveLength(3);
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  it("does the same when an answer starts and then stalls", async () => {
    vi.useFakeTimers();
    const { answer } = ask(async () => new Response(new ReadableStream({ start() {} }), { status: 200 }));
    await vi.advanceTimersByTimeAsync(PREVIEW_PART_TIME_LIMIT_MS);
    expect(answer.outcome).toEqual({ status: "error", message: DAYS_NOT_CALCULATED });
  });
});
