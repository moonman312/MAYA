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
  ALERT_NIGHTS_SHOWN,
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
    ).toBe('"Slow-date rescue" has 3 cuts on Sat, Nov 14 2026.');

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
    ).toBe('"Slow-date rescue" has 3 to 5 cuts on each of 2 nights.');

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
    ).toBe('"Hot-week surge" has 4 raises on each of 2 nights.');
  });

  it("puts a simulating hotel in the conditional, because nothing was sent", () => {
    const nights = [{ label: "Sat, Nov 14 2026", fires: 3 }];
    expect(alertHeadline({ ruleName: "R", direction: "decrease", nights, simulation: true })).toBe(
      '"R" would have 3 cuts on Sat, Nov 14 2026.',
    );
    expect(alertHeadline({ ruleName: "R", direction: "increase", nights: [{ label: "x", fires: 1 }], simulation: true })).toBe(
      '"R" would have 1 raise on x.',
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

  it("says a rule that raises on a fast pace counted only since the latest raise still on the night, against a whole window", () => {
    // Engine keepsWholeWindowBar: measured over fewer days than its window,
    // the rule counted from its own or a stronger rule's raise, and
    // window_expected is what a night like this gets in the whole window.
    expect(nightWhy(night({ window_days: 2, window_bookings: 5, window_expected: 2.33 }), "$", 7)).toEqual([
      "Since the raise before its latest one, by it or a stronger rule, 5 bookings came in. A night like this usually gets about 2 in a whole week.",
    ]);
    expect(nightWhy(night({ window_days: 4, window_bookings: 9, window_expected: 0.4 }), "$", 30)[0]).toBe(
      "Since the raise before its latest one, by it or a stronger rule, 9 bookings came in. A night like this usually gets almost none in a whole month.",
    );
    // Over its whole window it reads as before.
    expect(nightWhy(night({ window_days: 7, window_bookings: 9, window_expected: 2.33 }), "$", 7)[0]).toBe(
      "In the 7 days it measured, 9 bookings came in. A night like this usually has about 2 by then.",
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
      "Pickup over the 3 days it counted came to 6 room nights, against the 5 you set.",
    ]);
    const revenue = { ...rooms, pickup_metric: "revenue", pickup_threshold: 500, pickup_net: 1640.5 };
    expect(nightWhy(revenue, "€")).toEqual([
      "Pickup over the 3 days it counted came to €1,640.50, against the €500.00 you set.",
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
    expect(nightFiresLine(night({ room_types: rooms, fire_count: 3 }), roomTypeNames, "decrease")).toBe(
      "3 cuts on Standard and 1 cut on Suite",
    );
    expect(nightFiresLine(night(), roomTypeNames, "decrease")).toBe("3 cuts on Standard");
    expect(nightFiresLine(night(), roomTypeNames, "increase")).toBe("3 raises on Standard");
  });

  it("falls back to the count that filed the night when no room type can be named", () => {
    expect(nightFiresLine(night({ room_types: [] }), roomTypeNames, "decrease")).toBe("3 cuts");
    expect(nightFiresLine(night({ fire_count: 1, room_types: [] }), roomTypeNames, "increase")).toBe("1 raise");
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
    expect(card.nights[0].fires_line).toBe("3 cuts on Standard");
    expect(card.headline).toBe('"Slow-date rescue" has 3 cuts on each of 2 nights.');
  });

  it("lists the nearest nights and counts every one waiting, the headline included (audit A14)", () => {
    // 388 nights waiting, three cuts on each but four on the farthest.
    const many = Array.from({ length: 388 }, (_, i) =>
      night({ stay_date: new Date(Date.UTC(2026, 10, 1) + i * 86_400_000).toISOString().slice(0, 10), fire_count: i === 387 ? 4 : 3 }),
    );
    const [card] = build({ nights: [...many].reverse() });
    expect(card.night_count).toBe(388);
    expect(card.nights).toHaveLength(ALERT_NIGHTS_SHOWN);
    expect(card.nights[0].stay_date).toBe("2026-11-01");
    expect(card.headline).toBe('"Slow-date rescue" has 3 to 4 cuts on each of 388 nights.');
    expect(build({ nights: many, nightsShown: 5 })[0].nights.map((n) => n.stay_date)).toEqual([
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
    ]);
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
    expect(card.nights[0].fires_line).toBe("3 cuts on Standard and 1 cut on Suite");
    expect(card.nights[0].uneven).toBe(true);
    expect(card.headline).toBe('"Slow-date rescue" has up to 3 cuts on Sat, Nov 14 2026.');
  });

  it("names the whole window for a rule that raises on a fast pace, and only for that rule", () => {
    const short = [night({ window_days: 2, window_bookings: 5, window_expected: 2.33 })];
    const [raise] = build({ nights: short, wholeWindowDays: new Map([[RULE, 7]]) });
    expect(raise.nights[0].why[0]).toBe(
      "Since the raise before its latest one, by it or a stronger rule, 5 bookings came in. A night like this usually gets about 2 in a whole week.",
    );
    const [other] = build({ nights: short });
    expect(other.nights[0].why[0]).toBe("In the 2 days it measured, 5 bookings came in. A night like this usually has about 2 by then.");
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

    const unticked = stoppedNightsHelp(["2026-11-14", "2026-11-16"], false);
    expect(unticked.title).toBe("Stopped on 2 nights");
    expect(unticked.lines[0]).toBe("You told this rule to stop on Sat, Nov 14 2026 and Mon, Nov 16 2026.");
    expect(unticked.lines[1]).toBe("It makes no more changes there. What it already changed there stays.");
    expect(unticked.lines.join(" ")).toContain("Let it run again");
    expect(unticked.lines.join(" ")).toContain("MAYA asks you again");
    // A stop does not hold a ticked rule's changes against the cancellation check.
    expect(stoppedNightsHelp(["2026-11-14"], true).lines[1]).toBe(
      "It makes no more changes there. What it already changed there stays, unless cancellations mean the rule is no longer true.",
    );
  });

  it("lets the rule run again on every alert it was stopped under, in one request", () => {
    // One click is one thing the owner did. Posted once per alert, each
    // alert's nights got their own instant and the change log read as
    // several "let ... run again" lines.
    expect(
      letRunAgainBody({
        rule_id: "r1",
        alert_ids: ["a1", "a2"],
        nights: ["2026-11-14", "2026-11-16"],
        resume_nights: ["2026-11-14", "2026-11-16"],
      }),
    ).toEqual({
      alert_ids: ["a1", "a2"],
      stay_dates: ["2026-11-14", "2026-11-16"],
    });
  });

  it("takes the answer off the nights that have passed as well", () => {
    // The chip counts what the rule is doing nothing on, which a passed night
    // is not. The answer still has to come off it, or the change log reads as
    // if the owner had only ever stopped the rule on the leftovers.
    expect(
      letRunAgainBody({
        rule_id: "r1",
        alert_ids: ["a1"],
        nights: ["2026-11-16"],
        resume_nights: ["2026-08-01", "2026-11-16"],
      }).stay_dates,
    ).toEqual(["2026-08-01", "2026-11-16"]);
  });

  it("sums the rest up rather than listing a whole season", () => {
    const many = Array.from({ length: 30 }, (_, i) => `2026-11-${String(i + 1).padStart(2, "0")}`);
    const help = stoppedNightsHelp(many, true);
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
      alertChoiceHelp(false).title,
      ...alertChoiceHelp(false).lines,
      ...alertChoiceHelp(true).lines,
      alertLimitHelp("$").title,
      ...alertLimitHelp("$").lines,
      limitActionLabel("decrease"),
      limitActionLabel("increase"),
      stoppedChipLabel(3),
      ...stoppedNightsHelp(["2026-11-14"], false).lines,
      ...stoppedNightsHelp(["2026-11-14"], true).lines,
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

  it("promises only what the choice does, and says a ticked rule's change can still come off", () => {
    const unticked = alertChoiceHelp(false).lines.join(" ");
    expect(unticked).toContain("What it already changed there stays.");
    expect(unticked).toContain("MAYA stops asking");
    // A stop holds back new changes; it does not stop the cancellation check
    // taking a ticked rule's change off, raise or cut, so the help must not
    // promise that it does.
    const ticked = alertChoiceHelp(true).lines.join(" ");
    expect(ticked).toContain("What it already changed there stays, unless cancellations mean the rule is no longer true.");
    // And both say where a stopped night can be let go again.
    expect(unticked).toContain("Rules tab");
    expect(ticked).toContain("Rules tab");
  });

  it("reads each rule's box into its card: ticked unless the rule is unticked", () => {
    const cards = (unticked?: Set<string>) =>
      buildRuleAlerts({ alerts: [alert], nights: [night()], ruleNames, roomTypeNames, currencySymbol: "$", simulation: false, untickedRuleIds: unticked });
    expect(cards()[0].undo_on_cancellation).toBe(true);
    expect(cards(new Set([alert.rule_id]))[0].undo_on_cancellation).toBe(false);
  });
});
