import { describe, expect, it } from "vitest";
import { buildExplainView, humanDate } from "./explain";

const comparableSnapshot = {
  target: "2026-08-14",
  asOf: "2026-07-28",
  daysOut: 17,
  windowDays: 7,
  recentBookings: 9,
  expectedBookings: 4.2,
  method: "comparable",
  perComparable: [
    { date: "2025-08-15", bookings: 4, tier: 0, reasons: ["same season", "about a year earlier"], hasData: true },
    { date: "2024-08-16", bookings: 5, tier: 0, reasons: ["same season"], hasData: true },
    { date: "2023-08-18", bookings: 0, tier: 1, reasons: ["nearby weeks"], hasData: false },
  ],
  selection: {
    target: "2026-08-14",
    comparables: [],
    assumptions: {
      dayOfWeek: "Friday",
      dowClass: "weekend",
      holiday: null,
      seasonLabel: "Summer",
      seasonRange: "Jun 10 – Aug 24",
      relaxed: false,
    },
  },
  classification: {
    speed: "much_faster",
    rank: 2,
    label: "Much Faster Than Normal",
    ratio: 2.14,
    difference: 4.8,
    guard: "none",
    recentBookings: 9,
    expectedBookings: 4.2,
  },
};

describe("buildExplainView", () => {
  it("renders the comparable-method levels", () => {
    const view = buildExplainView(comparableSnapshot);
    expect(view).not.toBeNull();
    expect(view!.observed).toContain("9 bookings");
    expect(view!.observed).toContain("17 days");
    expect(view!.expected).toContain("about 4 bookings");
    expect(view!.verdict).toContain("Much Faster Than Normal");
    expect(view!.guard_note).toBeNull();
    expect(view!.method).toBe("comparable");
    expect(view!.assumptions).toContain(
      "Only other Friday nights were compared, since each night of the week books in its own way.",
    );
    expect(view!.assumptions).toContain(
      "Only nights in the same season of your history were compared: Summer (Jun 10 – Aug 24).",
    );
    expect(view!.comparables).toHaveLength(3);
    // hasData false reads as "we don't know", never as zero bookings.
    expect(view!.comparables[2].summary).toBe("no history for this night");
    expect(view!.comparables[0].summary).toBe("4 bookings in the same stretch");
  });

  it("explains holiday matching instead of season when a holiday is in play", () => {
    const snap = structuredClone(comparableSnapshot);
    snap.selection.assumptions.holiday = {
      key: "us_thanksgiving",
      label: "Thanksgiving",
      offset: -1,
      placement: "thursday",
      holidayDate: "2026-11-26",
    } as never;
    const view = buildExplainView(snap);
    const text = view!.assumptions.join(" ");
    expect(view!.assumptions).toContain(
      "This night is near Thanksgiving, so it is compared with the same days around Thanksgiving in earlier years, not the same date.",
    );
    expect(text).not.toContain("Summer");
    expect(text).not.toMatch(/orbit/);
  });

  it("notes when the search was widened", () => {
    const snap = structuredClone(comparableSnapshot);
    snap.selection.assumptions.relaxed = true;
    expect(buildExplainView(snap)!.assumptions).toContain(
      "Fewer than 4 nights matched closely, so the search was widened. Check the nights below and set aside any that were not normal.",
    );
  });

  it("translates evidence guards into honesty notes", () => {
    const snap = structuredClone(comparableSnapshot);
    snap.classification.guard = "few_comparables";
    expect(buildExplainView(snap)!.guard_note).toBe(
      "Only a few similar nights were found, so it stays within one step of Normal however strong the numbers look.",
    );
    snap.classification.guard = "small_difference";
    expect(buildExplainView(snap)!.guard_note).toBe(
      "The numbers leaned away from Normal, but by too little to matter at this many bookings, so it stays Normal.",
    );
    snap.classification.guard = "extreme_demoted";
    expect(buildExplainView(snap)!.guard_note).toBe(
      "The numbers pointed one step further from Normal, but not clearly enough, so it reads one step closer to Normal.",
    );
  });

  it("renders the momentum story with matched pairs, direction, and challengeable evidence", () => {
    const view = buildExplainView({
      ...comparableSnapshot,
      method: "momentum",
      perComparable: [],
      momentum: {
        expectedBookings: 3.1,
        momentumRatio: 1.4,
        neighborsUsed: 8,
        matchedPairs: 2,
        pairs: [
          { date: "2026-08-12", bookings: 3, yearAgoDate: "2025-08-13", yearAgoBookings: 2 },
          { date: "2026-08-16", bookings: 4, yearAgoDate: "2025-08-17", yearAgoBookings: 3 },
        ],
        naiveBaselineBookings: 2.2,
        baselineSource: "target_year_ago",
        baselineDate: "2025-08-15",
      },
    });
    expect(view!.method).toBe("momentum");
    expect(view!.momentum_notes.join(" ")).toContain("2 nearby nights");
    expect(view!.momentum_notes.join(" ")).toContain("40% faster");
    expect(view!.momentum_notes.join(" ")).toContain("best effort");
    expect(view!.assumptions.join(" ")).toContain("momentum");
    // The pairings and the baseline are challengeable evidence rows keyed
    // on the year-ago side — the falsifiability path for momentum reads.
    expect(view!.comparables.map((c) => c.date)).toEqual([
      "2025-08-13",
      "2025-08-17",
      "2025-08-15",
    ]);
    expect(view!.comparables[0].summary).toContain("2 bookings at this point last year");
    expect(view!.comparables[2].reasons.join(" ")).toContain("a year ago");
  });

  it("never claims an unchanged pace when zero pairs were measured", () => {
    // matchedPairs 0 makes the engine emit its neutral ratio placeholder of
    // exactly 1 — a no-evidence sentinel, not a measurement.
    const view = buildExplainView({
      ...comparableSnapshot,
      method: "momentum",
      perComparable: [],
      momentum: {
        expectedBookings: 2.2,
        momentumRatio: 1,
        neighborsUsed: 4,
        matchedPairs: 0,
        pairs: [],
        naiveBaselineBookings: 2.2,
        baselineSource: "neighbor_pace",
        baselineDate: null,
      },
    });
    const notes = view!.momentum_notes.join(" ");
    expect(notes).toContain("no telling whether the pace has changed");
    expect(notes).not.toContain("same pace as a year ago");
  });

  it("treats a near-1 measured ratio as unchanged, matching the level-1 wording", () => {
    const view = buildExplainView({
      ...comparableSnapshot,
      method: "momentum",
      perComparable: [],
      momentum: {
        expectedBookings: 2.3,
        momentumRatio: 1.03,
        neighborsUsed: 5,
        matchedPairs: 4,
        pairs: [],
        naiveBaselineBookings: 2.2,
        baselineSource: "neighbor_pace",
        baselineDate: null,
      },
    });
    expect(view!.momentum_notes.join(" ")).toContain("same pace as a year ago");
  });

  it("keeps the insufficient-data story honest against the shape the engine really persists", () => {
    // The engine writes expectedBookings: 0 (never null) and a fully
    // computed classification even when it blocked every booking-speed
    // rule — the view must not render that classification as a verdict.
    const view = buildExplainView({
      ...comparableSnapshot,
      method: "insufficient_data",
      recentBookings: 3,
      expectedBookings: 0,
      perComparable: [],
      classification: {
        speed: "faster",
        rank: 1,
        label: "Faster Than Normal",
        ratio: 6,
        difference: 2.5,
        guard: "few_comparables",
        recentBookings: 3,
        expectedBookings: 0,
      },
    });
    expect(view!.method).toBe("insufficient_data");
    expect(view!.expected).toBe("There isn't enough booking history yet to say what is usual for this night.");
    expect(view!.verdict).not.toContain("Faster Than Normal");
    expect(view!.verdict).toBe("Booking speed wasn't rated for this night, so rules that watch booking speed left it alone.");
    expect(view!.guard_note).toBeNull();
    expect(view!.assumptions.join(" ")).toContain("wasn't enough history");
  });

  it("returns null for legacy or malformed snapshots", () => {
    expect(buildExplainView(null)).toBeNull();
    expect(buildExplainView("nope")).toBeNull();
    expect(buildExplainView({})).toBeNull();
    expect(buildExplainView({ target: "2026-08-14" })).toBeNull();
    const noClassification = { ...comparableSnapshot, classification: undefined };
    expect(buildExplainView(noClassification)).toBeNull();
  });

  it("never uses math symbols in the prose", () => {
    const view = buildExplainView(comparableSnapshot)!;
    const all = [view.observed, view.expected, view.verdict, ...view.assumptions].join(" ");
    expect(all).not.toMatch(/[<>=≤≥]/);
  });

  it("says the usual number plainly, never what was expected or known", () => {
    const snaps = [
      comparableSnapshot,
      { ...comparableSnapshot, expectedBookings: 0.4 },
      { ...comparableSnapshot, method: "insufficient_data", perComparable: [] },
      { ...comparableSnapshot, classification: { ...comparableSnapshot.classification, guard: "few_comparables" } },
      {
        ...comparableSnapshot,
        method: "momentum",
        perComparable: [],
        momentum: { momentumRatio: 1.4, matchedPairs: 0, pairs: [], naiveBaselineBookings: 2.2, baselineSource: "neighbor_pace", baselineDate: null },
      },
      {
        ...comparableSnapshot,
        selection: {
          ...comparableSnapshot.selection,
          assumptions: { ...comparableSnapshot.selection.assumptions, relaxed: true, holiday: { label: "Thanksgiving" } },
        },
      },
    ];
    expect(buildExplainView(snaps[1])!.expected).toBe(
      "By this point, nights like this one usually get almost no bookings over the same stretch.",
    );
    for (const snap of snaps) {
      const view = buildExplainView(snap)!;
      const all = [view.observed, view.expected, view.verdict, view.guard_note ?? "", ...view.assumptions, ...view.momentum_notes, ...view.comparables.map((c) => c.summary)].join(" ");
      expect(all).not.toMatch(/\b(we|our|us|expect\w*|knew|know\w*|thinks?|learn\w*|analy[sz]\w*|model|call|held|softened|orbit)\b/i);
      expect(all).not.toContain("\u2014");
    }
  });
});

describe("which nights were compared (G28)", () => {
  // 2026-08-14 is a Friday.
  const withNights = (nights: { date: string; tier?: number }[], assumptions: Record<string, unknown> = {}) => ({
    ...comparableSnapshot,
    perComparable: nights.map((n) => ({ date: n.date, bookings: 3, tier: n.tier ?? 1, reasons: [], hasData: true })),
    selection: {
      ...comparableSnapshot.selection,
      assumptions: { ...comparableSnapshot.selection.assumptions, ...assumptions },
    },
  });
  const lines = (snap: unknown) => buildExplainView(snap)!.assumptions;

  it("names Saturday nights when too few Fridays matched, as the list under it shows", () => {
    const view = buildExplainView(
      withNights([{ date: "2025-08-15" }, { date: "2025-08-08" }, { date: "2025-08-16", tier: 2 }, { date: "2025-08-09", tier: 2 }], { relaxed: true }),
    )!;
    expect(view.assumptions[0]).toBe(
      "Too few other Friday nights matched, so Saturday nights were compared too, since they are also weekend nights. Friday and Saturday nights count as weekend nights, the rest as weekday nights.",
    );
    expect(view.assumptions.join(" ")).not.toContain("Only other Friday");
  });

  it("says instead when no other night of its own weekday matched", () => {
    expect(lines(withNights([{ date: "2025-08-16", tier: 2 }, { date: "2025-08-09", tier: 2 }]))[0]).toBe(
      "No other Friday nights matched, so Saturday nights were compared instead, since they are also weekend nights. Friday and Saturday nights count as weekend nights, the rest as weekday nights.",
    );
  });

  it("names the weekday nights used for a weekday night", () => {
    // 2026-08-12 is a Wednesday.
    const snap = {
      ...withNights([{ date: "2025-08-13" }, { date: "2025-08-11", tier: 2 }, { date: "2025-08-14", tier: 2 }, { date: "2025-08-10", tier: 2 }]),
      target: "2026-08-12",
    };
    expect(lines(snap)[0]).toBe(
      "Too few other Wednesday nights matched, so Sunday, Monday and Thursday nights were compared too, since they are also weekday nights. Friday and Saturday nights count as weekend nights, the rest as weekday nights.",
    );
  });

  it("around a holiday names the weekdays the nights fall on", () => {
    const snap = withNights(
      [{ date: "2025-07-03" }, { date: "2024-07-03" }, { date: "2023-07-03" }],
      { holiday: { key: "us_independence_day", label: "Independence Day", offset: -1, placement: "weekday", holidayDate: "2026-07-04" } },
    );
    const view = buildExplainView({ ...snap, target: "2026-07-03" })!;
    expect(view.assumptions[0]).toBe(
      "Around Independence Day the day of the week changes from year to year, so the nights compared fall on Monday, Wednesday and Thursday.",
    );
    expect(view.assumptions[1]).toContain("near Independence Day");
  });

  it("around a holiday that keeps its weekday, says only that weekday", () => {
    const snap = withNights([{ date: "2025-11-29" }, { date: "2024-11-30" }], {
      holiday: { key: "us_thanksgiving", label: "Thanksgiving", offset: 2, placement: "thursday", holidayDate: "2026-11-26" },
    });
    expect(lines({ ...snap, target: "2026-11-28" })[0]).toBe(
      "Only other Saturday nights were compared, since each night of the week books in its own way.",
    );
  });

  it("says when nights from outside the season were added, or used instead", () => {
    const mixed = lines(withNights([{ date: "2025-08-15" }, { date: "2023-06-02", tier: 3 }], { relaxed: true }));
    expect(mixed).toContain(
      "Nights in the same season of your history were compared: Summer (Jun 10 – Aug 24). Too few matched there, so nights within 45 days of the same time of year were added.",
    );
    const all = lines(withNights([{ date: "2023-06-02", tier: 3 }, { date: "2024-06-07", tier: 3 }], { relaxed: true }));
    expect(all).toContain(
      "Too few nights matched in the same season of your history, Summer (Jun 10 – Aug 24), so nights within 45 days of the same time of year were compared instead.",
    );
  });

  it("leaves the weekday line out when nothing was compared", () => {
    const view = buildExplainView(withNights([]))!;
    expect(view.assumptions.join(" ")).not.toMatch(/Friday|weekday nights/);
  });
});

describe("an observation cut short by the newest raise or cut by the rule or a stronger one", () => {
  // engine/pickup.ts countFromFireAt and bookingSpeedCountFrom: after a
  // raise on 2026-07-25 by the rule itself or a stronger raise rule, a raise
  // rule counts bookings made after that raise, the rest of the 25th
  // included (countedSince), 4 days by 2026-07-28. A cut rule counts the
  // full days after the day of the newest cut by itself or a stronger cut
  // rule, up to yesterday (countedThrough), from the 26th. A weaker rule's
  // change, or one the other way, never moves it.
  const raise = {
    ...comparableSnapshot,
    windowDays: 4,
    countedFrom: "2026-07-25",
    countedSince: "2026-07-25T12:00:00.000Z",
    fullWindowDays: 30,
    countedAfter: "raise",
  };
  const cut = {
    ...comparableSnapshot,
    windowDays: 2,
    countedFrom: "2026-07-26",
    fullWindowDays: 30,
    countedAfter: "cut",
    countedThrough: "2026-07-27",
  };

  it("says which days a raise rule counted and why, in plain words", () => {
    const view = buildExplainView(raise)!;
    expect(view.observed).toBe(
      "The newest raise still on this night's price, by the rule behind this reading or a stronger rule, was made on Sat, Jul 25 2026. In the 4 days from that raise on, 9 bookings arrived for it, with 17 days still to go before arrival.",
    );
    expect(view.expected).toContain("over the same stretch");
    expect(view.assumptions[0]).toBe(
      "Once a rule or a stronger one has raised this night, it counts only the bookings made after the newest of those raises still on the price, the rest of that day included, and reads the nights it is compared with over the same days. A weaker rule's raise, or any cut, doesn't move where it starts.",
    );
    expect(view.window_days).toBe(4);
    expect(buildExplainView({ ...raise, windowDays: 1, countedFrom: "2026-07-28", countedSince: "2026-07-28T09:00:00.000Z" })!.observed).toContain(
      "The newest raise still on this night's price, by the rule behind this reading or a stronger rule, was made on Tue, Jul 28 2026. Later that day, 9 bookings arrived for it,",
    );
    for (const line of [view.observed, view.assumptions[0]]) expect(line).not.toMatch(/[<>=≤≥—]/);
    expect(view.assumptions.join(" ")).not.toContain("whichever rule");
  });

  it("says a raise rule on a fast pace needed those bookings alone to beat a whole window of the nights it is compared with", () => {
    // keepsWholeWindowBar: the comparables were read over the rule's whole
    // 30 days, not the 4 it counted (expectedOverFullWindow).
    const view = buildExplainView({ ...raise, expectedOverFullWindow: true })!;
    expect(view.observed).toBe(buildExplainView(raise)!.observed);
    expect(view.expected).toBe("By this point, nights like this one usually get about 4 bookings over a whole month.");
    expect(view.expected).not.toContain("same stretch");
    expect(view.assumptions[0]).toBe(
      "Once a rule or a stronger one has raised this night, it counts only the bookings made after the newest of those raises still on the price, the rest of that day included, and those alone have to beat what the nights it is compared with get in a whole month. A weaker rule's raise, or any cut, doesn't move where it starts.",
    );
    expect(view.comparables[0].summary).toBe("4 bookings in a whole month");
    expect(buildExplainView({ ...raise, expectedOverFullWindow: true, fullWindowDays: 7 })!.expected).toContain("over a whole week.");
    // Without countedFrom the flag means nothing: the plain reading.
    expect(buildExplainView({ ...comparableSnapshot, expectedOverFullWindow: true })!.expected).toContain("over the same stretch");
    for (const line of [view.expected, view.assumptions[0], view.comparables[0].summary]) expect(line).not.toMatch(/[<>=≤≥—]/);
  });

  it("says a cut rule counted full days after the newest cut's day, up to yesterday", () => {
    const view = buildExplainView(cut)!;
    expect(view.observed).toBe(
      "The newest cut still on this night's price, by the rule behind this reading or a stronger rule, was made on Sat, Jul 25 2026. In the 2 full days after that, up to yesterday, 9 bookings arrived for it, with 17 days still to go before arrival.",
    );
    expect(view.assumptions.slice(0, 2)).toEqual([
      "A rule that cuts counts full days only, up to yesterday, on this night and on the nights it is compared with alike.",
      "Once a rule or a stronger one has cut this night, it counts only the full days after the day of the newest of those cuts still on the price, and reads the nights it is compared with over the same days. A weaker rule's cut, or any raise, doesn't move where it starts.",
    ]);
    expect(buildExplainView({ ...cut, windowDays: 1, countedFrom: "2026-07-27" })!.observed).toContain(
      "The newest cut still on this night's price, by the rule behind this reading or a stronger rule, was made on Sun, Jul 26 2026. In the full day after that, up to yesterday,",
    );
    for (const line of [view.observed, ...view.assumptions.slice(0, 2)]) expect(line).not.toMatch(/[<>=≤≥—]/);
  });

  it("says a cut rule's whole window is full days up to yesterday", () => {
    const view = buildExplainView({ ...comparableSnapshot, windowDays: 30, countedThrough: "2026-07-27" })!;
    expect(view.observed.startsWith("In the 30 full days up to yesterday, 9 bookings arrived for this night,")).toBe(true);
    expect(view.assumptions[0]).toBe(
      "A rule that cuts counts full days only, up to yesterday, on this night and on the nights it is compared with alike.",
    );
    expect(view.assumptions.join(" ")).not.toContain("Once a rule");
  });

  it("reads a snapshot that doesn't say raise or cut as a change", () => {
    const view = buildExplainView({ ...raise, countedAfter: undefined })!;
    expect(view.observed).toContain("The newest change still on this night's price, by the rule behind this reading or a stronger rule, was made on Sat, Jul 25 2026. In the 4 days from that change on,");
    expect(view.assumptions[0]).toBe(
      "Once a rule or a stronger one has changed this night, it counts only the bookings made after the newest of those changes still on the price, the rest of that day included, and reads the nights it is compared with over the same days. A weaker rule's change doesn't move where it starts.",
    );
    const noSince = buildExplainView({ ...raise, countedAfter: undefined, countedSince: undefined, countedFrom: "2026-07-26", windowDays: 3 })!;
    expect(noSince.observed).toContain("The newest change still on this night's price, by the rule behind this reading or a stronger rule, was made on Sat, Jul 25 2026. In the 3 days after that,");
    expect(noSince.assumptions[0]).toContain("counts only the bookings made after the day of the newest of those changes still on the price,");
  });

  it("reads a whole-window snapshot as it always did", () => {
    const view = buildExplainView(comparableSnapshot)!;
    expect(view.observed.startsWith("In the last 7 days,")).toBe(true);
    expect(view.assumptions.join(" ")).not.toContain("Once a rule");
    expect(view.assumptions.join(" ")).not.toContain("full days");
  });
});

describe("humanDate", () => {
  it("formats with weekday and year", () => {
    expect(humanDate("2026-08-14")).toBe("Fri, Aug 14 2026");
    expect(humanDate("2024-02-29")).toBe("Thu, Feb 29 2024");
  });

  it("passes through unparseable input", () => {
    expect(humanDate("not-a-date")).toBe("not-a-date");
  });
});

describe("an observation over some of the room types", () => {
  const names = new Map([
    ["std", "Standard"],
    ["dlx", "Deluxe"],
  ]);

  it("says which room types the bookings were, with the counts it measured", () => {
    const view = buildExplainView({ ...comparableSnapshot, measuredRoomTypeIds: ["std", "dlx"] }, names)!;
    expect(view.measured).toEqual(["Standard", "Deluxe"]);
    expect(view.observed).toBe(
      "In the last 7 days, 9 Standard and Deluxe bookings arrived for this night, with 17 days still to go before arrival.",
    );
    expect(view.comparables.map((c) => c.summary)).toEqual(buildExplainView(comparableSnapshot)!.comparables.map((c) => c.summary));
    const unnamed = buildExplainView({ ...comparableSnapshot, measuredRoomTypeIds: ["gone"] }, names)!;
    expect(unnamed.observed).toContain("9 bookings for the room types this rule watches arrived");
  });

  it("reads an older snapshot exactly as before", () => {
    const view = buildExplainView(comparableSnapshot, names)!;
    expect(view.measured).toBeNull();
    expect(view.observed).toBe("In the last 7 days, 9 bookings arrived for this night, with 17 days still to go before arrival.");
  });
});
