/**
 * What the banner says when a rule keeps adjusting the same night.
 *
 * Every sentence here is read by an owner who is about to decide whether to
 * let a rule carry on, so the tests are mostly about the words: that they
 * match what the engine does (the rule keeps firing, the price heads for the
 * limit in its direction, a default limit stops nothing), that a simulating
 * hotel is told what would have happened, and that nothing sneaks in an em
 * dash or a math symbol.
 */
import { describe, expect, it } from "vitest";
import {
  alertChoiceHelp,
  alertConsequence,
  alertHeadline,
  alertLimitHelp,
  buildRuleAlerts,
  letRunAgainBody,
  limitActionLabel,
  nightFiresLine,
  nightLimit,
  nightLimitLine,
  nightWhy,
  stoppedChipLabel,
  stoppedNightsHelp,
  type AlertNightRow,
  type AlertRow,
} from "@/lib/rule-alerts";

const STD = "11111111-1111-4111-8111-111111111111";
const SUITE = "22222222-2222-4222-8222-222222222222";
const RULE = "33333333-3333-4333-8333-333333333333";
const ALERT = "44444444-4444-4444-8444-444444444444";

const roomTypeNames = new Map([
  [STD, "Standard"],
  [SUITE, "Suite"],
]);
const ruleNames = new Map([[RULE, "Slow-date rescue"]]);

function night(over: Partial<AlertNightRow> = {}): AlertNightRow {
  return {
    alert_id: ALERT,
    rule_id: RULE,
    stay_date: "2026-11-14",
    fire_count: 3,
    last_fire_at: "2026-09-17T10:00:00Z",
    window_days: 30,
    window_bookings: 1,
    window_expected: 6,
    pickup_metric: null,
    pickup_threshold: null,
    pickup_window_days: null,
    pickup_net: null,
    room_types: [{ room_type_id: STD, fires: 3, limit: 80, limit_is_default: false, price: 104 }],
    ...over,
  };
}

const alert: AlertRow = {
  id: ALERT,
  rule_id: RULE,
  rule_version: 1,
  action_direction: "decrease",
  opened_at: "2026-09-17T10:00:00Z",
};

describe("alertHeadline", () => {
  it("names the night when there is one, and the range when there are several", () => {
    expect(
      alertHeadline({
        ruleName: "Slow-date rescue",
        direction: "decrease",
        nights: [{ label: "Sat, Nov 14 2026", fires: 3 }],
        simulation: false,
      }),
    ).toBe('"Slow-date rescue" has cut Sat, Nov 14 2026 3 times.');

    expect(
      alertHeadline({
        ruleName: "Slow-date rescue",
        direction: "decrease",
        nights: [
          { label: "a", fires: 3 },
          { label: "b", fires: 5 },
        ],
        simulation: false,
      }),
    ).toBe('"Slow-date rescue" has cut 2 nights, 3 to 5 times each.');

    expect(
      alertHeadline({
        ruleName: "Hot-week surge",
        direction: "increase",
        nights: [
          { label: "a", fires: 4 },
          { label: "b", fires: 4 },
        ],
        simulation: false,
      }),
    ).toBe('"Hot-week surge" has raised 2 nights, 4 times each.');
  });

  it("puts a simulating hotel in the conditional, because nothing was sent", () => {
    const nights = [{ label: "Sat, Nov 14 2026", fires: 3 }];
    expect(alertHeadline({ ruleName: "R", direction: "decrease", nights, simulation: true })).toContain(
      "would have cut",
    );
    expect(alertHeadline({ ruleName: "R", direction: "increase", nights, simulation: true })).toContain(
      "would have raised",
    );
    expect(alertConsequence("decrease", true)).toBe("It would keep cutting these nights until you stop it.");
    expect(alertConsequence("increase", false)).toBe("It keeps raising these nights until you stop it.");
  });
});

describe("nightWhy", () => {
  it("gives the bookings measured against the pace similar nights set", () => {
    expect(nightWhy(night(), "$")).toEqual([
      "In the 30 days it measured, 1 booking came in. A night like this usually has about 6 by then.",
    ]);
  });

  it("says when more cancelled than came in, and when a night like it usually has almost none", () => {
    expect(nightWhy(night({ window_bookings: -2, window_expected: 0.4 }), "$")[0]).toBe(
      "In the 30 days it measured, more bookings cancelled than came in. A night like this usually has almost none by then.",
    );
    expect(nightWhy(night({ window_bookings: 0, window_expected: null }), "$")[0]).toBe(
      "In the 30 days it measured, no bookings came in.",
    );
  });

  it("gives a pickup rule its own sentence, in rooms or in money", () => {
    const rooms = night({
      window_days: null,
      window_bookings: null,
      window_expected: null,
      pickup_metric: "room_nights",
      pickup_threshold: 5,
      pickup_window_days: 3,
      pickup_net: 6,
    });
    expect(nightWhy(rooms, "$")).toEqual([
      "Pickup over the last 3 days came to 6 room nights, against the 5 you set.",
    ]);
    const revenue = { ...rooms, pickup_metric: "revenue", pickup_threshold: 500, pickup_net: 1640.5 };
    expect(nightWhy(revenue, "€")).toEqual([
      "Pickup over the last 3 days came to €1,640.50, against the €500.00 you set.",
    ]);
  });

  it("says both when the rule watches both", () => {
    expect(
      nightWhy(
        night({ pickup_metric: "room_nights", pickup_threshold: 5, pickup_window_days: 3, pickup_net: 6 }),
        "$",
      ),
    ).toHaveLength(2);
  });
});

describe("nightLimit", () => {
  it("heads for the lowest floor on a cut and the highest ceiling on a raise", () => {
    const rooms = [
      { room_type_id: STD, fires: 3, limit: 80, limit_is_default: false, price: 100 },
      { room_type_id: SUITE, fires: 3, limit: 60, limit_is_default: false, price: 200 },
    ];
    expect(nightLimit(night({ room_types: rooms }), "decrease", roomTypeNames)).toEqual({
      limit: 60,
      names: ["Suite"],
      isDefault: false,
    });
    const ceilings = [
      { room_type_id: STD, fires: 3, limit: 400, limit_is_default: false, price: 100 },
      { room_type_id: SUITE, fires: 3, limit: 900, limit_is_default: false, price: 200 },
    ];
    expect(nightLimit(night({ room_types: ceilings }), "increase", roomTypeNames)).toEqual({
      limit: 900,
      names: ["Suite"],
      isDefault: false,
    });
  });

  it("has nothing to say when the run loaded no limit for the room type", () => {
    const rooms = [{ room_type_id: STD, fires: 3, limit: null, limit_is_default: null, price: null }];
    expect(nightLimit(night({ room_types: rooms }), "decrease", roomTypeNames)).toBeNull();
  });
});

describe("nightLimitLine", () => {
  it("names where the price can end up", () => {
    expect(nightLimitLine({ limit: 80, names: ["Standard"], isDefault: false }, "decrease", "$", false)).toBe(
      "If it keeps cutting, the price can fall to your $80.00 floor for Standard.",
    );
    expect(
      nightLimitLine({ limit: 400, names: ["Standard", "Suite"], isDefault: false }, "increase", "$", false),
    ).toBe("If it keeps raising, the price can climb to your $400.00 ceiling for Standard and Suite.");
  });

  it("says a limit nobody has set stops nothing in practice", () => {
    expect(nightLimitLine({ limit: 1, names: ["Standard"], isDefault: true }, "decrease", "$", false)).toBe(
      "Your floor for Standard is still MAYA's $1.00 default, so the price can fall that far.",
    );
    expect(nightLimitLine({ limit: 99999.99, names: ["Standard"], isDefault: true }, "increase", "$", false)).toBe(
      "Your ceiling for Standard is still MAYA's $99,999.99 default, so the price can climb that far.",
    );
  });

  it("keeps a simulating hotel in the conditional, like the rest of its card", () => {
    // MAYA has sent nothing to its PMS, so no published price can go anywhere.
    expect(nightLimitLine({ limit: 80, names: ["Standard"], isDefault: false }, "decrease", "$", true)).toBe(
      "If it kept cutting, the price would fall to your $80.00 floor for Standard.",
    );
    expect(nightLimitLine({ limit: 400, names: ["Standard"], isDefault: false }, "increase", "$", true)).toBe(
      "If it kept raising, the price would climb to your $400.00 ceiling for Standard.",
    );
    expect(nightLimitLine({ limit: 1, names: ["Standard"], isDefault: true }, "decrease", "$", true)).toBe(
      "Your floor for Standard is still MAYA's $1.00 default, so the price would fall that far.",
    );
    expect(nightLimitLine({ limit: 99999.99, names: ["Standard"], isDefault: true }, "increase", "$", true)).toBe(
      "Your ceiling for Standard is still MAYA's $99,999.99 default, so the price would climb that far.",
    );
  });
});

describe("nightFiresLine", () => {
  it("gives every room type its own count", () => {
    const rooms = [
      { room_type_id: STD, fires: 3, limit: 80, limit_is_default: false, price: 100 },
      { room_type_id: SUITE, fires: 1, limit: 80, limit_is_default: false, price: 200 },
    ];
    expect(nightFiresLine(night({ room_types: rooms, fire_count: 3 }), roomTypeNames)).toBe(
      "3 times on Standard and once on Suite",
    );
    expect(nightFiresLine(night(), roomTypeNames)).toBe("3 times on Standard");
  });

  it("falls back to the count that filed the night when no room type can be named", () => {
    expect(nightFiresLine(night({ room_types: [] }), roomTypeNames)).toBe("3 times");
    expect(nightFiresLine(night({ fire_count: 1, room_types: [] }), roomTypeNames)).toBe("once");
  });
});

describe("buildRuleAlerts", () => {
  const build = (over: Partial<Parameters<typeof buildRuleAlerts>[0]> = {}) =>
    buildRuleAlerts({
      alerts: [alert],
      nights: [night({ stay_date: "2026-11-16" }), night({ stay_date: "2026-11-14" })],
      ruleNames,
      roomTypeNames,
      currencySymbol: "$",
      simulation: false,
      ...over,
    });

  it("groups a rule's nights into one card, oldest night first", () => {
    const [card] = build();
    expect(card.rule_name).toBe("Slow-date rescue");
    expect(card.nights.map((n) => n.stay_date)).toEqual(["2026-11-14", "2026-11-16"]);
    expect(card.nights[0].label).toBe("Sat, Nov 14 2026");
    expect(card.nights[0].fires_line).toBe("3 times on Standard");
    expect(card.headline).toBe('"Slow-date rescue" has cut 2 nights, 3 times each.');
  });

  it("leaves out an alert with nothing left to answer, and one whose rule it cannot name", () => {
    expect(build({ nights: [] })).toEqual([]);
    expect(build({ ruleNames: new Map() })).toEqual([]);
  });

  it("counts each room type on its own, and says \"up to\" in the headline that has one number", () => {
    // Standard cut three times, Suite once: the card must not say it cut the
    // Suite three times.
    const [card] = build({
      nights: [
        night({
          fire_count: 3,
          room_types: [
            { room_type_id: STD, fires: 3, limit: 80, limit_is_default: false, price: 100 },
            { room_type_id: SUITE, fires: 1, limit: 80, limit_is_default: false, price: 200 },
          ],
        }),
      ],
    });
    expect(card.nights[0].fires_line).toBe("3 times on Standard and once on Suite");
    expect(card.nights[0].uneven).toBe(true);
    expect(card.headline).toBe('"Slow-date rescue" has cut Sat, Nov 14 2026 up to 3 times.');
  });

  it("carries the default-limit warning through to the night", () => {
    const [card] = build({
      nights: [
        night({
          room_types: [{ room_type_id: STD, fires: 3, limit: 1, limit_is_default: true, price: 12 }],
        }),
      ],
    });
    expect(card.nights[0].limit_is_default).toBe(true);
    expect(card.nights[0].limit_line).toContain("default");
  });
});

describe("the nights a rule was stopped on", () => {
  it("names them on the chip and behind it, and says what the stop left in place", () => {
    expect(stoppedChipLabel(12)).toBe("Stopped on 12 nights");
    expect(stoppedChipLabel(1)).toBe("Stopped on 1 night");

    const cut = stoppedNightsHelp(["2026-11-14", "2026-11-16"], "decrease");
    expect(cut.title).toBe("Stopped on 2 nights");
    expect(cut.lines[0]).toBe("You told this rule to stop on Sat, Nov 14 2026 and Mon, Nov 16 2026.");
    expect(cut.lines[1]).toContain("What it already cut stays.");
    expect(cut.lines.join(" ")).toContain("Let it run again");
    expect(cut.lines.join(" ")).toContain("MAYA asks you again");
    // A stop does not hold a raise against the cancellation check.
    expect(stoppedNightsHelp(["2026-11-14"], "increase").lines[1]).toContain(
      "unless enough of the bookings behind it cancel",
    );
  });

  it("lets the rule run again by clearing the answer, not by answering again", () => {
    // keep_adjusting cleared the stop and silenced the night for good, so a
    // rule that went on adjusting it never reached the owner again.
    expect(letRunAgainBody(["2026-11-14", "2026-11-16"])).toEqual({
      choice: "resume",
      stay_dates: ["2026-11-14", "2026-11-16"],
    });
  });

  it("sums the rest up rather than listing a whole season", () => {
    const many = Array.from({ length: 30 }, (_, i) => `2026-11-${String(i + 1).padStart(2, "0")}`);
    const help = stoppedNightsHelp(many, "decrease");
    expect(help.lines[0]).toContain("and 22 more nights");
    expect(help.lines[0]).toContain("Sun, Nov 1 2026");
    expect(help.lines[0]).not.toContain("Nov 30");
  });
});

describe("the words themselves", () => {
  it("has no em dashes and no math symbols anywhere", () => {
    const [card] = buildRuleAlerts({
      alerts: [alert],
      nights: [night()],
      ruleNames,
      roomTypeNames,
      currencySymbol: "$",
      simulation: false,
    });
    const every = [
      card.headline,
      card.consequence,
      ...card.nights.flatMap((n) => [...n.why, n.limit_line ?? ""]),
      alertChoiceHelp("decrease").title,
      ...alertChoiceHelp("decrease").lines,
      ...alertChoiceHelp("increase").lines,
      alertLimitHelp("$").title,
      ...alertLimitHelp("$").lines,
      limitActionLabel("decrease"),
      limitActionLabel("increase"),
      stoppedChipLabel(3),
      ...stoppedNightsHelp(["2026-11-14"], "decrease").lines,
      ...stoppedNightsHelp(["2026-11-14"], "increase").lines,
    ].join(" ");
    expect(every).not.toContain("—");
    expect(every).not.toMatch(/[<>≥≤]|[^a-z]=[^a-z]/i);
  });

  it("offers the right thing to set when the limit is MAYA's own", () => {
    expect(limitActionLabel("decrease")).toBe("Ask MAYA for a floor");
    expect(limitActionLabel("increase")).toBe("Ask MAYA for a ceiling");
    // The help has to point at something that exists: "Ask MAYA for help" on
    // the Rules tab is what proposes guardrails (onboarding/suggest.ts).
    expect(alertLimitHelp("$").lines.join(" ")).toContain("Rules tab");
  });

  it("promises only what the choice does, and says a raise can still come off", () => {
    const cut = alertChoiceHelp("decrease").lines.join(" ");
    expect(cut).toContain("What it already cut stays.");
    expect(cut).toContain("MAYA stops asking");
    // A stop holds back new fires; it does not stop the cancellation check
    // taking a raise off, so the help must not promise that it does.
    const raise = alertChoiceHelp("increase").lines.join(" ");
    expect(raise).toContain("unless enough of the bookings behind it cancel");
    expect(raise).not.toContain("What it already changed stays.");
    // And both say where a stopped night can be let go again.
    expect(cut).toContain("Rules tab");
    expect(raise).toContain("Rules tab");
  });
});
