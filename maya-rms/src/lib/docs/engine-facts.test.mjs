// The widgets' numbers against what the docs pages say. Run with: npm test
import { test } from "vitest";
import assert from "node:assert/strict";
import { engineFacts, floorOffers, occupancyFires, priceFor, readBookingSpeed, sellableOccupancy, stackPrice } from "./engine-facts.ts";
import { fallbackFor, WIDGET_NAMES } from "./widget-fallbacks.mjs";

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
  assert.equal(Math.round(sellableOccupancy(12, 3, 8)), 89);
  assert.equal(Math.round(sellableOccupancy(12, 3, 10)), 111);
  assert.equal(sellableOccupancy(3, 3, 0), null);
  assert.equal(occupancyFires(80, "greater", 80), false);
  assert.equal(occupancyFires(80.01, "greater", 80), true);
  assert.equal(occupancyFires(null, "less", 50), false);
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
  for (const name of WIDGET_NAMES) {
    const s = fallbackFor(name);
    assert.ok(!/[–—!]/.test(s), `${name}: no dashes or exclamation marks`);
  }
});
