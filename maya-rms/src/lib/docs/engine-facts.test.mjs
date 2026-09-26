// The widgets' numbers against what the docs pages say. Run with: npm test
import { test } from "vitest";
import assert from "node:assert/strict";
import { engineFacts, floorOffers, occupancyFires, priceFor, readBookingSpeed, sellableOccupancy, stackPrice } from "./engine-facts.ts";
import { fallbackFor, occupancySentence, WIDGET_NAMES } from "./widget-fallbacks.mjs";
import { ruleConditionsMatch } from "../engine/conditions.ts";
import { computeOccupancy } from "../engine/metrics.ts";
import { applyAdjustments, clampPrice } from "../engine/pricing.ts";
import { conditionRowsToRuleCondition, newConditionRow } from "../rule-form.ts";

test("booking speed matches the worked table on the booking speed in detail page", () => {
  // expected: [bookings, level] pairs straight from the table, five or more similar nights
  const table = {
    0: [[0, "Normal"], [1, "Normal"], [2, "Much Faster Than Normal"], [3, "Much Faster Than Normal"], [4, "Surging"]],
    1: [[0, "Normal"], [2, "Normal"], [3, "Much Faster Than Normal"], [4, "Much Faster Than Normal"], [5, "Surging"]],
    3: [[0, "Much Slower Than Normal"], [1, "Normal"], [5, "Normal"], [6, "Much Faster Than Normal"], [10, "Much Faster Than Normal"], [11, "Surging"]],
    5: [[0, "Stalled"], [1, "Much Slower Than Normal"], [2, "Normal"], [8, "Normal"], [9, "Faster Than Normal"], [10, "Much Faster Than Normal"], [17, "Much Faster Than Normal"], [18, "Surging"]],
    10: [[2, "Stalled"], [3, "Much Slower Than Normal"], [5, "Much Slower Than Normal"], [6, "Normal"], [14, "Normal"], [15, "Faster Than Normal"], [19, "Faster Than Normal"], [20, "Much Faster Than Normal"], [34, "Much Faster Than Normal"], [35, "Surging"]],
    20: [[5, "Stalled"], [6, "Much Slower Than Normal"], [10, "Much Slower Than Normal"], [11, "Slower Than Normal"], [13, "Slower Than Normal"], [14, "Normal"], [26, "Normal"], [27, "Faster Than Normal"], [39, "Faster Than Normal"], [40, "Much Faster Than Normal"], [69, "Much Faster Than Normal"], [70, "Surging"]],
  };
  for (const [expected, rows] of Object.entries(table)) {
    for (const [recent, level] of rows) {
      assert.equal(readBookingSpeed(Number(expected), recent, 5).level, level, `expected ${expected}, received ${recent}`);
    }
  }
});

test("with fewer than five similar nights the level stays one step from Normal", () => {
  assert.equal(readBookingSpeed(5, 18, 4).level, "Faster Than Normal");
  assert.equal(readBookingSpeed(5, 0, 3).level, "Slower Than Normal");
  assert.equal(readBookingSpeed(0.4, 2, 5).level, "Normal", "against 0.4, two bookings read Normal");
  assert.equal(readBookingSpeed(0.4, 3, 5).level, "Much Faster Than Normal");
  assert.equal(readBookingSpeed(0.4, 5, 5).level, "Surging");
});

test("sellable occupancy is strict, can pass 100, and has nothing to say with no rooms to sell", () => {
  assert.equal(Math.round(sellableOccupancy(12, 3, 8) * 100), 89);
  assert.equal(Math.round(sellableOccupancy(12, 3, 10) * 100), 111);
  assert.equal(sellableOccupancy(3, 3, 0), null);
  assert.equal(occupancyFires(0.8, "greater", 80), false);
  assert.equal(occupancyFires(0.8001, "greater", 80), true);
  assert.equal(occupancyFires(null, "less", 50), false);
});

// What the engine does with the same night: the rule form stores the
// threshold as a share, computeOccupancy works out booked over sellable, and
// ruleConditionsMatch compares the two.
function engineFires(rooms, outOfService, booked, compare, threshold) {
  const row = newConditionRow("occupancy", { operator: compare === "greater" ? "gt" : "lt", value: String(threshold) });
  const rule = { condition: conditionRowsToRuleCondition([row]) };
  const snap = new Map([["rt", { booked_units: booked, sellable_units: Math.max(0, rooms - outOfService) }]]);
  return ruleConditionsMatch(rule, { occupancy: computeOccupancy(snap, ["rt"]), dta: 0 });
}

test("the occupancy slider fires exactly when the engine would, for every setting the slider allows", () => {
  const conditions = [];
  for (const compare of ["greater", "less"]) {
    for (let threshold = 0; threshold <= 100; threshold++) {
      const row = newConditionRow("occupancy", { operator: compare === "greater" ? "gt" : "lt", value: String(threshold) });
      conditions.push({ compare, threshold, rule: { condition: conditionRowsToRuleCondition([row]) } });
    }
  }
  const mismatches = [];
  for (let rooms = 1; rooms <= 40; rooms++) {
    for (let oos = 0; oos <= rooms; oos++) {
      for (let booked = 0; booked <= rooms; booked++) {
        const snap = new Map([["rt", { booked_units: booked, sellable_units: rooms - oos }]]);
        const metrics = { occupancy: computeOccupancy(snap, ["rt"]), dta: 0 };
        const share = sellableOccupancy(rooms, oos, booked);
        for (const { compare, threshold, rule } of conditions) {
          if (occupancyFires(share, compare, threshold) !== ruleConditionsMatch(rule, metrics)) {
            mismatches.push(`${rooms}/${oos}/${booked} ${compare} ${threshold}`);
          }
        }
      }
    }
  }
  assert.deepEqual(mismatches.slice(0, 5), []);
});

test("the occupancy fallback sentence fires exactly when the engine would", () => {
  // 11 of 20 is exactly 55%, which a Greater than 55 rule does not pass
  assert.match(occupancySentence({ rooms: 20, outOfService: 0, booked: 11, threshold: 55 }), /55% sellable occupancy, so a Greater than 55 rule does not fire\.$/);
  for (let rooms = 1; rooms <= 40; rooms++) {
    for (const outOfService of [0, 1, 3]) {
      for (let booked = 0; booked <= rooms; booked++) {
        for (let threshold = 0; threshold <= 100; threshold++) {
          for (const compare of ["greater", "less"]) {
            const says = occupancySentence({ rooms, outOfService, booked, threshold, compare }).endsWith(" rule fires.");
            assert.equal(says, engineFires(rooms, outOfService, booked, compare, threshold), `${rooms}/${outOfService}/${booked} ${compare} ${threshold}`);
          }
        }
      }
    }
  }
});

test("stacking multiplies percents, adds amounts, and holds at the floor and ceiling", () => {
  const up = (value, kind = "percent") => ({ kind, direction: "up", value });
  assert.deepEqual(stackPrice(200, [up(10), up(25)], 110, 400).steps, [220, 275]);
  assert.equal(stackPrice(200, [up(10), up(25)], 110, 400).published, 275);
  const capped = stackPrice(275, [up(10)], 110, 300);
  assert.equal(capped.published, 300);
  assert.equal(capped.clampedBy, "ceiling");
  assert.equal(stackPrice(200, [up(25, "amount")], 0, 999).published, 225);
  assert.equal(stackPrice(150, [{ kind: "percent", direction: "down", value: 60 }], 80, 300).published, 80);
  assert.equal(stackPrice(200, [up(10), up(25)], 110, 400).steps.length, 2);
  assert.equal(stackPrice(165, [up(25)], 0, 999).published, 206.25);
});

// The engine's own price for the same night: applyAdjustments stacks the
// changes and rounds to the cent, then clampPrice holds it.
function enginePrice(base, changes, floor, ceiling) {
  const specs = changes.map((c, i) => ({
    rule_id: String(i),
    action_kind: c.kind === "percent" ? "percent" : "fixed",
    action_direction: c.direction === "up" ? "increase" : "decrease",
    action_value: c.value,
  }));
  return clampPrice(applyAdjustments(base, specs, []), floor, ceiling);
}

test("stacking publishes the engine's price and names the limit the engine names", () => {
  const same = (base, changes, floor, ceiling) => {
    const widget = stackPrice(base, changes, floor, ceiling);
    const engine = enginePrice(base, changes, floor, ceiling);
    const what = JSON.stringify([base, changes, floor, ceiling]);
    assert.equal(widget.published, engine.final, what);
    assert.equal(widget.clampedBy ?? "none", engine.clamped_by, what);
  };
  const down = (value) => ({ kind: "percent", direction: "down", value });
  const up = (value) => ({ kind: "percent", direction: "up", value });
  // $200 less 10% and 30% is $126.00 once rounded, so a $126 floor holds nothing
  same(200, [down(10), down(30)], 126, 300);
  assert.equal(stackPrice(200, [down(10), down(30)], 126, 300).clampedBy, null);
  same(200, [up(10), up(0)], 110, 220);
  // with the floor above the ceiling, the ceiling is checked first
  same(500, [up(0), up(0)], 400, 300);
  assert.equal(stackPrice(500, [up(0), up(0)], 400, 300).published, 300);

  // Many made-up nights, a quarter of them with a limit exactly on the price.
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 20000; i++) {
    const base = Math.round(rand() * 50000) / 100;
    const changes = [0, 1].map(() => ({
      kind: rand() < 0.7 ? "percent" : "amount",
      direction: rand() < 0.5 ? "up" : "down",
      value: Math.round(rand() * 60),
    }));
    const onTheLine = enginePrice(base, changes, -Infinity, Infinity).final;
    const pick = rand();
    const floor = pick < 0.125 ? onTheLine : Math.round(rand() * 30000) / 100;
    const ceiling = pick > 0.875 ? onTheLine : Math.round(rand() * 60000) / 100;
    same(base, changes, floor, ceiling);
  }
});

test("the bill follows the brackets on the what it costs page", () => {
  assert.equal(priceFor(20, "monthly").total, 110);
  assert.equal(priceFor(20, "yearly").total, 1320);
  assert.equal(priceFor(21, "monthly").total, 105);
  assert.equal(priceFor(21, "yearly").total, 1134);
  assert.equal(priceFor(40, "yearly").total, 2160);
  assert.equal(priceFor(100, "monthly").total, 250);
  assert.equal(priceFor(100, "yearly").total, 2700);
  assert.equal(priceFor(3, "monthly").total, 16.5);
  assert.equal(priceFor(5, "monthly").total, 27.5);
  assert.equal(priceFor(501, "monthly"), null);
});

test("the floor question's offers match the five questions page", () => {
  assert.deepEqual(floorOffers(35), [50, 60, 70, 85]);
  assert.equal(floorOffers(null)[0], engineFacts.floorLadder.skippedFirstOffer);
});

test("every widget has its fallback sentence, and the sentences agree with the maths", () => {
  for (const name of WIDGET_NAMES) assert.equal(typeof fallbackFor(name), "string", name);
  assert.equal(fallbackFor("NotAWidget"), null);
  assert.match(fallbackFor("OccupancySlider"), /^Twelve rooms, three out of service, eight booked: 89% sellable occupancy, so a Greater than 80 rule fires\.$/);
  assert.match(fallbackFor("OccupancySlider", { rooms: 12, outOfService: 2, booked: 9, threshold: 80 }), /90% sellable occupancy/);
  assert.equal(readBookingSpeed(5, 9, 5).level, "Faster Than Normal");
  assert.match(fallbackFor("BookingSpeedPlayground"), /Faster Than Normal/);
  assert.match(fallbackFor("PriceCalculator"), /\$110 a month.*\$105 a month.*\$1,134/);
  assert.match(fallbackFor("FloorLadder"), /\$50, then \$60, \$70 and \$85/);
  // the dashboard puts its banners after the tab row, as the tour drawing does
  assert.match(fallbackFor("AppTour"), /banners under the tabs/);
  assert.ok(!/above the tabs/.test(fallbackFor("AppTour")));
  for (const name of WIDGET_NAMES) {
    const s = fallbackFor(name);
    assert.ok(!/[–—!]/.test(s), `${name}: no dashes or exclamation marks`);
  }
});
