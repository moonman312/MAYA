import { describe, expect, it } from "vitest";
import {
  applyStep,
  describeConditions,
  narrateChange,
  narrateHeadline,
  type NarrativeApplication,
} from "./changelog-narrative";

const NO_MATH_SYMBOLS = /[<>]/;

function app(o: Partial<NarrativeApplication>): NarrativeApplication {
  return {
    rule_name: "Busy-day bump",
    condition: { occupancy_operator: "gt", occupancy_threshold: 0.7 },
    action: { kind: "percent", direction: "increase", value: 10 },
    metrics: { occupancy: 0.82 },
    is_pickup: false,
    ...o,
  };
}

describe("describeConditions", () => {
  it("reads occupancy as fullness against the owner's own mark", () => {
    expect(
      describeConditions(
        { occupancy_operator: "gt", occupancy_threshold: 0.7 },
        { occupancy: 0.82 },
      ),
    ).toEqual(["It was 82% full, past the 70% mark you set."]);
  });

  it("handles under / beyond directions", () => {
    expect(
      describeConditions(
        { occupancy_operator: "lt", occupancy_threshold: 0.3 },
        { occupancy: 0.22 },
      ),
    ).toEqual(["It was 22% full, under the 30% mark you set."]);
    expect(
      describeConditions({ dta_operator: "lt", dta_threshold_days: 7 }, { dta: 3 }),
    ).toEqual(["It had 3 days to go, past the 7-day mark you set."]);
    expect(
      describeConditions({ dta_operator: "gt", dta_threshold_days: 45 }, { dta: 60 }),
    ).toEqual(["It had 60 days to go, beyond the 45-day mark you set."]);
  });

  it("fuses occupancy and the booking window into one sentence", () => {
    expect(
      describeConditions(
        {
          occupancy_operator: "gt",
          occupancy_threshold: 0.9,
          dta_operator: "lt",
          dta_threshold_days: 21,
        },
        { occupancy: 0.95, dta: 17 },
      ),
    ).toEqual(["It was 95% full with 17 days to go, past the 90% and 21-day marks you set."]);
  });

  it("spells out both sides when the two marks are crossed opposite ways", () => {
    expect(
      describeConditions(
        {
          occupancy_operator: "lt",
          occupancy_threshold: 0.3,
          dta_operator: "gt",
          dta_threshold_days: 45,
        },
        { occupancy: 0.22, dta: 60 },
      ),
    ).toEqual([
      "It was 22% full with 60 days to go, under the 30% mark and beyond the 45-day mark you set.",
    ]);
  });

  it("puts the occupancy exclusion after the main clause, never inside it", () => {
    expect(
      describeConditions(
        { occupancy_operator: "gt", occupancy_threshold: 0.7 },
        { occupancy: 0.82, excluded_from_occupancy: ["Court", "Parking"] },
      ),
    ).toEqual([
      "It was 82% full, past the 70% mark you set.",
      "That 82% leaves out Court and Parking.",
    ]);
  });

  it("gives each condition family its own short sentence", () => {
    const out = describeConditions(
      {
        occupancy_operator: "gt",
        occupancy_threshold: 0.7,
        dta_operator: "lt",
        dta_threshold_days: 7,
        pickup_operator: "gt",
        pickup_threshold: 4,
        pickup_window_days: 3,
      },
      { occupancy: 0.82, dta: 3, pickup_units: 9 },
    );
    expect(out).toEqual([
      "It was 82% full with 3 days to go, past the 70% and 7-day marks you set.",
      "9 bookings arrived in the last 3 days, past the 4-booking mark you set.",
    ]);
    for (const s of out) expect(s).not.toMatch(NO_MATH_SYMBOLS);
  });

  it("stays grammatical when observed metrics are missing", () => {
    expect(
      describeConditions({ occupancy_operator: "gt", occupancy_threshold: 0.7 }, null),
    ).toEqual(["This night was past the 70% mark you set."]);
    expect(
      describeConditions(
        { pickup_operator: "lt", pickup_threshold: 2, pickup_window_days: 7 },
        null,
      ),
    ).toEqual(["Bookings in the last 7 days came in under the 2-booking mark you set."]);
  });

  it("says nothing at all when there is no condition to report", () => {
    expect(describeConditions(null)).toEqual([]);
    expect(describeConditions({}, { occupancy: 0.82 })).toEqual([]);
  });

  it("singularizes 1 day / 1 booking", () => {
    const out = describeConditions(
      {
        dta_operator: "lt",
        dta_threshold_days: 1,
        pickup_operator: "gt",
        pickup_threshold: 1,
        pickup_window_days: 1,
      },
      { dta: 1, pickup_units: 1 },
    );
    expect(out[0]).toBe("It had 1 day to go, past the 1-day mark you set.");
    expect(out[1]).toBe("1 booking arrived in the last 1 day, past the 1-booking mark you set.");
  });
});

describe("applyStep mirrors the engine math", () => {
  it("compounds percent and adds fixed", () => {
    expect(applyStep(200, { kind: "percent", direction: "increase", value: 10 })).toBe(220);
    expect(applyStep(220, { kind: "fixed", direction: "increase", value: 15 })).toBe(235);
    expect(applyStep(235, { kind: "percent", direction: "increase", value: 12 })).toBe(263.2);
    expect(applyStep(200, { kind: "percent", direction: "decrease", value: 5 })).toBe(190);
    expect(applyStep(190, { kind: "fixed", direction: "decrease", value: 15 })).toBe(175);
  });
});

describe("narrateChange: complex chained rules", () => {
  it("tells the full story of a three-rule chain with running prices", () => {
    const sentences = narrateChange({
      room_type: "Deluxe King",
      base_price: 200,
      final_price: 263.2,
      applications: [
        app({}),
        app({
          rule_name: "Last-minute premium",
          condition: { dta_operator: "lt", dta_threshold_days: 7 },
          action: { kind: "fixed", direction: "increase", value: 15 },
          metrics: { dta: 3 },
        }),
        app({
          rule_name: "Demand-spike catcher",
          condition: { pickup_operator: "gt", pickup_threshold: 4, pickup_window_days: 3 },
          action: { kind: "percent", direction: "increase", value: 12 },
          metrics: { pickup_units: 9 },
          is_pickup: true,
        }),
      ],
    });

    expect(sentences).toEqual([
      '"Busy-day bump" raised this night 10%, from $200.00 to $220.00.',
      "It was 82% full, past the 70% mark you set.",
      'Then "Last-minute premium" raised it $15.00, from $220.00 to $235.00.',
      "It had 3 days to go, past the 7-day mark you set.",
      'Then "Demand-spike catcher" raised it 12%, from $235.00 to $263.20.',
      "9 bookings arrived in the last 3 days, past the 4-booking mark you set.",
    ]);

    for (const s of sentences) expect(s).not.toMatch(NO_MATH_SYMBOLS);
  });

  it("leads with the outcome, then the reason", () => {
    const sentences = narrateChange({
      room_type: "Suite",
      base_price: 300,
      final_price: 345,
      applications: [
        app({
          rule_name: "Compression surge",
          condition: {
            occupancy_operator: "gt",
            occupancy_threshold: 0.85,
            dta_operator: "lt",
            dta_threshold_days: 3,
          },
          action: { kind: "percent", direction: "increase", value: 15 },
          metrics: { occupancy: 0.91, dta: 2 },
        }),
      ],
    });
    expect(sentences).toEqual([
      '"Compression surge" raised this night 15%, from $300.00 to $345.00.',
      "It was 91% full with 2 days to go, past the 85% and 3-day marks you set.",
    ]);
  });

  it("narrates decreases without spin", () => {
    const sentences = narrateChange({
      room_type: "Standard Queen",
      base_price: 180,
      final_price: 162,
      applications: [
        app({
          rule_name: "Slow-night saver",
          condition: { occupancy_operator: "lt", occupancy_threshold: 0.3 },
          action: { kind: "percent", direction: "decrease", value: 10 },
          metrics: { occupancy: 0.2 },
        }),
      ],
    });
    expect(sentences).toEqual([
      '"Slow-night saver" lowered this night 10%, from $180.00 to $162.00.',
      "It was 20% full, under the 30% mark you set.",
    ]);
  });

  it("makes the ceiling the owner's, in its own sentence", () => {
    const sentences = narrateChange({
      room_type: "Deluxe King",
      base_price: 280,
      final_price: 300,
      ceiling_price: 300,
      clamped_by: "ceiling",
      applications: [app({ action: { kind: "percent", direction: "increase", value: 15 } })],
    });
    expect(sentences[sentences.length - 1]).toBe(
      "That would have gone past your $300.00 ceiling for Deluxe King, so it stopped there.",
    );
  });

  it("makes the floor the owner's too", () => {
    const sentences = narrateChange({
      room_type: "Standard Queen",
      base_price: 90,
      final_price: 79,
      floor_price: 79,
      clamped_by: "floor",
      applications: [
        app({
          rule_name: "Slow-night saver",
          condition: { occupancy_operator: "lt", occupancy_threshold: 0.3 },
          action: { kind: "percent", direction: "decrease", value: 20 },
          metrics: { occupancy: 0.15 },
        }),
      ],
    });
    expect(sentences[sentences.length - 1]).toBe(
      "That would have dropped under your $79.00 floor for Standard Queen, so it stopped there.",
    );
  });

  it("names the price that shipped if it ever misses the limit itself", () => {
    const sentences = narrateChange({
      room_type: "Deluxe King",
      base_price: 280,
      final_price: 295,
      ceiling_price: 300,
      clamped_by: "ceiling",
      applications: [app({ action: { kind: "percent", direction: "increase", value: 15 } })],
    });
    expect(sentences[sentences.length - 1]).toBe(
      "That would have gone past your $300.00 ceiling for Deluxe King, so it stopped at $295.00.",
    );
  });

  it("never emits math comparison symbols, ever", () => {
    // Belt-and-braces sweep across a pile of shapes.
    const shapes: NarrativeApplication[] = [
      app({}),
      app({ condition: null }),
      app({ metrics: null }),
      app({
        condition: {
          occupancy_operator: "lt",
          occupancy_threshold: 0.25,
          pickup_operator: "gt",
          pickup_threshold: 12,
          pickup_window_days: 7,
        },
      }),
    ];
    for (const a of shapes) {
      const out = narrateChange({
        room_type: "X",
        base_price: 100,
        final_price: 110,
        applications: [a],
      });
      for (const s of out) expect(s).not.toMatch(NO_MATH_SYMBOLS);
    }
  });

  it("still narrates the move when a rule has no condition to explain", () => {
    expect(
      narrateChange({
        room_type: "Suite",
        base_price: 200,
        final_price: 220,
        applications: [app({ rule_name: "Flat bump", condition: null, metrics: null })],
      }),
    ).toEqual(['"Flat bump" raised this night 10%, from $200.00 to $220.00.']);
  });

  it("falls back to a plain movement sentence when no rule detail exists", () => {
    const sentences = narrateChange({
      room_type: "Suite",
      base_price: 250,
      final_price: 265,
      applications: [],
    });
    expect(sentences).toEqual(["The rate moved from $250.00 to $265.00."]);
  });
});

describe("narrateHeadline", () => {
  it("summarizes the move", () => {
    expect(
      narrateHeadline({
        room_type: "Deluxe King",
        base_price: 200,
        final_price: 263.2,
        applications: [],
      }),
    ).toBe("Deluxe King: $200.00 up to $263.20 (+31.6%)");
  });
});

describe("booking speed narration", () => {
  it("narrates the starter-ladder slow rule exactly as an owner should read it", () => {
    const sentences = narrateChange({
      room_type: "Deluxe King",
      base_price: 200,
      final_price: 170,
      applications: [
        {
          rule_name: "Slow month catch-up",
          condition: {
            booking_speed_operator: "at_least",
            booking_speed_level: "much_slower",
            booking_speed_window_days: 30,
          },
          action: { kind: "percent", direction: "decrease", value: 15 },
          metrics: { booking_speed: { label: "Much Slower Than Normal", recent: 3, expected: 9.2 } },
          is_pickup: true,
        },
      ],
    });
    expect(sentences).toEqual([
      '"Slow month catch-up" lowered this night 15%, from $200.00 to $170.00.',
      "Bookings came in much slower than normal this past month: 3, against the 9 a night like this usually has by now.",
    ]);
    for (const s of sentences) expect(s).not.toMatch(NO_MATH_SYMBOLS);
  });

  it("keeps the level lowercase in prose, whatever the operator was", () => {
    expect(
      describeConditions(
        { booking_speed_operator: "is", booking_speed_level: "normal", booking_speed_window_days: 1 },
        { booking_speed: { label: "Normal", recent: 6, expected: 5 } },
      ),
    ).toEqual([
      "Bookings came in at the normal pace this past day: 6, against the 5 a night like this usually has by now.",
    ]);
    expect(
      describeConditions({
        booking_speed_operator: "at_most",
        booking_speed_level: "slower",
        booking_speed_window_days: 7,
      }),
    ).toEqual(["Bookings came in slower than normal this past week."]);
    expect(
      describeConditions({
        booking_speed_operator: "at_least",
        booking_speed_level: "much_faster",
        booking_speed_window_days: 7,
      }),
    ).toEqual(["Bookings came in much faster than normal this past week."]);
  });

  it("gives stalled and surging their own verb rather than a label in a sentence", () => {
    expect(
      describeConditions(
        { booking_speed_operator: "at_least", booking_speed_level: "surging", booking_speed_window_days: 1 },
        { booking_speed: { label: "Surging", recent: 6, expected: 0.4 } },
      ),
    ).toEqual([
      "Bookings surged this past day: 6, where a night like this usually has almost none by now.",
    ]);
    expect(
      describeConditions(
        { booking_speed_operator: "at_most", booking_speed_level: "stalled", booking_speed_window_days: 7 },
        { booking_speed: { label: "Stalled", recent: 0, expected: 5 } },
      ),
    ).toEqual([
      "Bookings all but stopped this past week: none, against the 5 a night like this usually has by now.",
    ]);
  });

  it("says plainly when a night lost more bookings than it took", () => {
    expect(
      describeConditions(
        { booking_speed_operator: "at_most", booking_speed_level: "much_slower", booking_speed_window_days: 30 },
        { booking_speed: { label: "Much Slower Than Normal", recent: -2, expected: 9 } },
      ),
    ).toEqual([
      "Bookings came in much slower than normal this past month: more cancelled than booked, against the 9 a night like this usually has by now.",
    ]);
  });

  it("keeps booking speed as its own sentence beside another condition family", () => {
    const out = describeConditions(
      {
        occupancy_operator: "gt",
        occupancy_threshold: 0.6,
        booking_speed_operator: "at_least",
        booking_speed_level: "faster",
        booking_speed_window_days: 7,
      },
      { occupancy: 0.72, booking_speed: { label: "Faster Than Normal", recent: 11, expected: 6 } },
    );
    expect(out).toEqual([
      "It was 72% full, past the 60% mark you set.",
      "Bookings came in faster than normal this past week: 11, against the 6 a night like this usually has by now.",
    ]);
    for (const s of out) expect(s).not.toMatch(NO_MATH_SYMBOLS);
  });
});

/*
 * Harbor Light Inn, the canonical example property. These exact strings are
 * what the marketing screens show, so they are pinned here character for
 * character rather than spot-checked.
 */
describe("Harbor Light Inn change log", () => {
  const speed = (
    level: string,
    windowDays: 1 | 7 | 30,
    recent: number,
    expected: number,
    operator: "at_least" | "at_most" | "is" = "at_least",
  ): Pick<NarrativeApplication, "condition" | "metrics"> => ({
    condition: {
      booking_speed_operator: operator,
      booking_speed_level: level,
      booking_speed_window_days: windowDays,
    },
    metrics: { booking_speed: { label: level, recent, expected } },
  });

  const festival: Pick<NarrativeApplication, "condition" | "metrics"> = {
    condition: {
      occupancy_operator: "gt",
      occupancy_threshold: 0.9,
      dta_operator: "lt",
      dta_threshold_days: 21,
    },
    metrics: { occupancy: 0.95, excluded_from_occupancy: ["Pickleball Court"], dta: 17 },
  };

  it("Hot-week surge on Harbor View King, 24 Oct", () => {
    expect(
      narrateChange({
        room_type: "Harbor View King",
        base_price: 349,
        final_price: 436.25,
        floor_price: 249,
        ceiling_price: 749,
        applications: [
          {
            rule_name: "Hot-week surge",
            action: { kind: "percent", direction: "increase", value: 25 },
            is_pickup: true,
            ...speed("much_faster", 7, 14, 5),
          },
        ],
      }),
    ).toEqual([
      '"Hot-week surge" raised this night 25%, from $349.00 to $436.25.',
      "Bookings came in much faster than normal this past week: 14, against the 5 a night like this usually has by now.",
    ]);
  });

  it("Festival weekend hold on Courtyard Suite, 3 Oct", () => {
    expect(
      narrateChange({
        room_type: "Courtyard Suite",
        base_price: 529,
        final_price: 592.48,
        floor_price: 379,
        ceiling_price: 1099,
        applications: [
          {
            rule_name: "Festival weekend hold",
            action: { kind: "percent", direction: "increase", value: 12 },
            is_pickup: false,
            ...festival,
          },
        ],
      }),
    ).toEqual([
      '"Festival weekend hold" raised this night 12%, from $529.00 to $592.48.',
      "It was 95% full with 17 days to go, past the 90% and 21-day marks you set.",
      "That 95% leaves out Pickleball Court.",
    ]);
  });

  it("Slow-date rescue on Garden Queen, 6 Oct", () => {
    expect(
      narrateChange({
        room_type: "Garden Queen",
        base_price: 289,
        final_price: 245.65,
        floor_price: 199,
        ceiling_price: 599,
        applications: [
          {
            rule_name: "Slow-date rescue",
            action: { kind: "percent", direction: "decrease", value: 15 },
            is_pickup: true,
            ...speed("much_slower", 30, 2, 9, "at_most"),
          },
        ],
      }),
    ).toEqual([
      '"Slow-date rescue" lowered this night 15%, from $289.00 to $245.65.',
      "Bookings came in much slower than normal this past month: 2, against the 9 a night like this usually has by now.",
    ]);
  });

  it("Slow-date trim on Loft Studio, 13 Oct", () => {
    expect(
      narrateChange({
        room_type: "Loft Studio",
        base_price: 399,
        final_price: 371.07,
        floor_price: 279,
        ceiling_price: 849,
        applications: [
          {
            rule_name: "Slow-date trim",
            action: { kind: "percent", direction: "decrease", value: 7 },
            is_pickup: true,
            ...speed("slower", 30, 3, 5, "is"),
          },
        ],
      }),
    ).toEqual([
      '"Slow-date trim" lowered this night 7%, from $399.00 to $371.07.',
      "Bookings came in slower than normal this past month: 3, against the 5 a night like this usually has by now.",
    ]);
  });

  it("Warm-date bump on Harbor View King, 31 Oct", () => {
    expect(
      narrateChange({
        room_type: "Harbor View King",
        base_price: 349,
        final_price: 383.9,
        floor_price: 249,
        ceiling_price: 749,
        applications: [
          {
            rule_name: "Warm-date bump",
            action: { kind: "percent", direction: "increase", value: 10 },
            is_pickup: true,
            ...speed("faster", 30, 9, 6),
          },
        ],
      }),
    ).toEqual([
      '"Warm-date bump" raised this night 10%, from $349.00 to $383.90.',
      "Bookings came in faster than normal this past month: 9, against the 6 a night like this usually has by now.",
    ]);
  });

  it("two rules on one night: the second acts on the price the first left", () => {
    expect(
      narrateChange({
        room_type: "Courtyard Suite",
        base_price: 529,
        final_price: 740.6,
        floor_price: 379,
        ceiling_price: 1099,
        applications: [
          {
            rule_name: "Hot-week surge",
            action: { kind: "percent", direction: "increase", value: 25 },
            is_pickup: true,
            ...speed("much_faster", 7, 14, 5),
          },
          {
            rule_name: "Festival weekend hold",
            action: { kind: "percent", direction: "increase", value: 12 },
            is_pickup: false,
            ...festival,
          },
        ],
      }),
    ).toEqual([
      '"Hot-week surge" raised this night 25%, from $529.00 to $661.25.',
      "Bookings came in much faster than normal this past week: 14, against the 5 a night like this usually has by now.",
      'Then "Festival weekend hold" raised it 12%, from $661.25 to $740.60.',
      "It was 95% full with 17 days to go, past the 90% and 21-day marks you set.",
      "That 95% leaves out Pickleball Court.",
    ]);
  });

  it("a typed base rate that runs into the ceiling", () => {
    expect(
      narrateChange({
        room_type: "Harbor View King",
        base_price: 699,
        final_price: 749,
        floor_price: 249,
        ceiling_price: 749,
        clamped_by: "ceiling",
        applications: [
          {
            rule_name: "Hot-week surge",
            action: { kind: "percent", direction: "increase", value: 25 },
            is_pickup: true,
            ...speed("much_faster", 7, 14, 5),
          },
        ],
      }),
    ).toEqual([
      '"Hot-week surge" raised this night 25%, from $699.00 to $873.75.',
      "Bookings came in much faster than normal this past week: 14, against the 5 a night like this usually has by now.",
      "That would have gone past your $749.00 ceiling for Harbor View King, so it stopped there.",
    ]);
  });
});
