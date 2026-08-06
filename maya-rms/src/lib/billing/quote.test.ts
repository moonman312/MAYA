/**
 * The subscribe panel's arithmetic. The case that matters most is the
 * fixed-price code: its tier cap decides the billed count, and a panel that
 * quotes the typed count instead promises a number Stripe will not charge.
 */
import { describe, expect, it } from "vitest";
import { checkoutQuote } from "./quote";

describe("checkoutQuote with no code", () => {
  it("prices the typed rooms at their own bracket", () => {
    const q = checkoutQuote(12, "month");
    expect(q).toMatchObject({
      perRoomCents: 550,
      recurringCents: 6600,
      firstCents: 6600,
    });
  });

  it("annual applies the bracket discount, first bracket exempt", () => {
    expect(checkoutQuote(12, "year").recurringCents).toBe(12 * 550 * 12);
    expect(checkoutQuote(24, "year").recurringCents).toBe(Math.round(24 * 500 * 12 * 0.9));
  });
});

describe("checkoutQuote with percent discounts", () => {
  it("forever discounts the headline itself", () => {
    const q = checkoutQuote(10, "month", { percentOff: 20, discountDuration: "forever" });
    expect(q.recurringCents).toBe(Math.round(5500 * 0.8));
    expect(q.firstCents).toBe(q.recurringCents);
    expect(q.discountMonths).toBeUndefined();
  });

  it("repeating months discount the first invoice and say for how long", () => {
    const q = checkoutQuote(10, "month", { percentOff: 50, discountDuration: 3 });
    expect(q.recurringCents).toBe(5500);
    expect(q.firstCents).toBe(2750);
    expect(q.discountMonths).toBe(3);
  });

  it("the annual-rescaled once form discounts the first year only", () => {
    // 50% for 3 months rescales to 12.5% of the annual invoice.
    const q = checkoutQuote(10, "year", { percentOff: 12.5, discountDuration: "once" });
    expect(q.recurringCents).toBe(66000);
    expect(q.firstCents).toBe(Math.round(66000 * 0.875));
    expect(q.discountMonths).toBeUndefined();
  });

  it("repeating months on an annual invoice keep no month tail", () => {
    // A 12-month coupon covers the whole first annual invoice; the panel says
    // "first year", not "first 12 months".
    const q = checkoutQuote(10, "year", { percentOff: 20, discountDuration: 12 });
    expect(q.firstCents).toBe(Math.round(66000 * 0.8));
    expect(q.discountMonths).toBeUndefined();
  });
});

describe("checkoutQuote with a trial", () => {
  it("carries the trial through without touching the price", () => {
    const q = checkoutQuote(10, "month", { trialDays: 30 });
    expect(q.trialDays).toBe(30);
    expect(q.firstCents).toBe(5500);
  });
});

describe("checkoutQuote with dollar discounts", () => {
  it("forever comes off the headline", () => {
    const q = checkoutQuote(10, "month", { amountOffCents: 2000, discountDuration: "forever" });
    expect(q.recurringCents).toBe(3500);
    expect(q.firstCents).toBe(3500);
  });

  it("limited months discount the first invoice and say for how long", () => {
    const q = checkoutQuote(10, "month", { amountOffCents: 2000, discountDuration: 3 });
    expect(q.recurringCents).toBe(5500);
    expect(q.firstCents).toBe(3500);
    expect(q.discountMonths).toBe(3);
  });

  it("floors at zero rather than promising a negative bill", () => {
    const q = checkoutQuote(1, "month", { amountOffCents: 99900, discountDuration: "forever" });
    expect(q.recurringCents).toBe(0);
  });
});
