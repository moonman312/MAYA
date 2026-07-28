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
  it("reads occupancy in words with the observed value", () => {
    const s = describeConditions(
      { occupancy_operator: "gt", occupancy_threshold: 0.7 },
      { occupancy: 0.82 },
    );
    expect(s).toBe("occupancy (82%) was above 70%");
  });

  it("handles below / fewer-than directions", () => {
    expect(
      describeConditions(
        { occupancy_operator: "lt", occupancy_threshold: 0.3 },
        { occupancy: 0.22 },
      ),
    ).toBe("occupancy (22%) was below 30%");
    expect(
      describeConditions(
        { dta_operator: "lt", dta_threshold_days: 7 },
        { dta: 3 },
      ),
    ).toBe("the stay was fewer than 7 days away (3 days out)");
  });

  it("joins a three-condition rule like a person would", () => {
    const s = describeConditions(
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
    expect(s).toBe(
      "occupancy (82%) was above 70%, the stay was fewer than 7 days away (3 days out), and 9 bookings arrived in the last 3 days, more than the 4 bookings trigger",
    );
    expect(s).not.toMatch(NO_MATH_SYMBOLS);
  });

  it("stays grammatical when observed metrics are missing", () => {
    const s = describeConditions(
      { occupancy_operator: "gt", occupancy_threshold: 0.7 },
      null,
    );
    expect(s).toBe("occupancy was above 70%");
  });

  it("singularizes 1 day / 1 booking", () => {
    const s = describeConditions(
      { dta_operator: "lt", dta_threshold_days: 1, pickup_operator: "gt", pickup_threshold: 1, pickup_window_days: 1 },
      { dta: 1, pickup_units: 1 },
    );
    expect(s).toContain("fewer than 1 day away");
    expect(s).toContain("1 booking arrived in the last 1 day");
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

    expect(sentences).toHaveLength(3);
    expect(sentences[0]).toBe(
      '"Busy-day bump" kicked in because occupancy (82%) was above 70%, which raised the rate 10%, from $200.00 to $220.00.',
    );
    expect(sentences[1]).toBe(
      'Then "Last-minute premium" kicked in because the stay was fewer than 7 days away (3 days out), which raised the rate $15.00, from $220.00 to $235.00.',
    );
    expect(sentences[2]).toContain('"Demand-spike catcher"');
    expect(sentences[2]).toContain("9 bookings arrived in the last 3 days");
    expect(sentences[2]).toContain("from $235.00 to $263.20");

    for (const s of sentences) expect(s).not.toMatch(NO_MATH_SYMBOLS);
  });

  it("narrates a multi-condition rule as one sentence", () => {
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
    expect(sentences).toHaveLength(1);
    expect(sentences[0]).toContain("occupancy (91%) was above 85% and the stay was fewer than 3 days away (2 days out)");
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
    expect(sentences[0]).toBe(
      '"Slow-night saver" kicked in because occupancy (20%) was below 30%, which lowered the rate 10%, from $180.00 to $162.00.',
    );
  });

  it("explains a ceiling clamp in its own sentence", () => {
    const sentences = narrateChange({
      room_type: "Deluxe King",
      base_price: 280,
      final_price: 300,
      ceiling_price: 300,
      clamped_by: "ceiling",
      applications: [app({ action: { kind: "percent", direction: "increase", value: 15 } })],
    });
    expect(sentences).toHaveLength(2);
    expect(sentences[1]).toBe(
      "That landed above the $300.00 ceiling for Deluxe King, so the final rate was capped at $300.00.",
    );
  });

  it("explains a floor clamp", () => {
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
    expect(sentences[1]).toBe(
      "That landed below the $79.00 floor for Standard Queen, so the final rate was held at $79.00.",
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
    const text = sentences.join(" ");
    expect(text).toContain("booking speed over the past month");
    expect(text).toContain("(3 bookings, expected about 9)");
    expect(text).toContain("lowered the rate 15%, from $200.00 to $170.00");
    for (const s of sentences) expect(s).not.toMatch(NO_MATH_SYMBOLS);
  });

  it("phrases each operator distinctly and handles the almost-none expectation", () => {
    const is = describeConditions(
      { booking_speed_operator: "is", booking_speed_level: "surging", booking_speed_window_days: 1 },
      { booking_speed: { label: "Surging", recent: 6, expected: 0.4 } },
    );
    expect(is).toContain("booking speed over the past day was Surging");
    expect(is).toContain("(6 bookings, expected almost none)");

    const atMost = describeConditions({
      booking_speed_operator: "at_most",
      booking_speed_level: "slower",
      booking_speed_window_days: 7,
    });
    expect(atMost).toBe("booking speed over the past week stayed at or below Slower Than Normal");

    const atLeast = describeConditions({
      booking_speed_operator: "at_least",
      booking_speed_level: "much_faster",
      booking_speed_window_days: 7,
    });
    expect(atLeast).toContain("reached Much Faster Than Normal");
    for (const s of [is, atMost, atLeast]) expect(s).not.toMatch(NO_MATH_SYMBOLS);
  });

  it("joins booking speed with other condition families", () => {
    const s = describeConditions(
      {
        occupancy_operator: "gt",
        occupancy_threshold: 0.6,
        booking_speed_operator: "at_least",
        booking_speed_level: "faster",
        booking_speed_window_days: 7,
      },
      { occupancy: 0.72, booking_speed: { label: "Faster Than Normal", recent: 11, expected: 6 } },
    );
    expect(s).toContain("occupancy (72%) was above 60%");
    expect(s).toContain("and booking speed over the past week reached Faster Than Normal");
    expect(s).not.toMatch(NO_MATH_SYMBOLS);
  });
});
