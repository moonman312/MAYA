import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkCode, checkoutEffectFor, describeCode, displayEffectFor, type SignupCode } from "./codes";

function code(o: Partial<SignupCode> = {}): SignupCode {
  return {
    id: "code-1",
    code: "DRIFTWOOD",
    kind: "trial",
    trial_days: 7,
    percent_off: null,
    duration_months: null,
    fixed_price_cents: null,
    fixed_price_interval: null,
    tier_rooms_cap: null,
    amount_off_cents: null,
    max_redemptions: null,
    expires_at: null,
    is_active: true,
    stripe_coupon_id: null,
    ...o,
  };
}

/**
 * Postgres ILIKE, honestly.
 *
 * This used to be stubbed as an identity function that returned the row no
 * matter what was searched for, which is precisely why the whole suite passed
 * while a single `%` walked past the signup gate. Wildcards have to behave like
 * wildcards here or these tests cannot see that class of bug at all.
 */
function ilikeMatches(pattern: string, value: string): boolean {
  const rx = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${rx}$`, "i").test(value);
}

/**
 * Minimal stand-in for the two tables checkCode reads. `redemptions` is what a
 * count/lookup sees; `row` is the code it finds (null = unknown code).
 */
function fakeAdmin(row: SignupCode | null, redemptions: { hotel_id: string | null }[] = []) {
  const client = {
    from: (table: string) => {
      if (table === "signup_codes") {
        return {
          select: () => ({
            ilike: (_col: string, pattern: string) => ({
              maybeSingle: async () =>
                row && ilikeMatches(pattern, row.code)
                  ? { data: row, error: null }
                  : { data: null, error: null },
            }),
          }),
        };
      }
      // signup_code_redemptions: either a head count, or a per-hotel lookup.
      return {
        select: (_cols: string, opts?: { count?: string; head?: boolean }) => {
          if (opts?.head) {
            return { eq: async () => ({ count: redemptions.length, error: null }) };
          }
          return {
            eq: () => ({
              eq: (_col: string, hotelId: string) => ({
                maybeSingle: async () => ({
                  data: redemptions.find((r) => r.hotel_id === hotelId) ?? null,
                  error: null,
                }),
              }),
            }),
          };
        },
      };
    },
  } as unknown as SupabaseClient;
  return client;
}

const NOW = new Date("2026-07-29T12:00:00Z");

describe("checkCode gates signup", () => {
  it("accepts a good code", async () => {
    const res = await checkCode(fakeAdmin(code()), "DRIFTWOOD", { now: NOW });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.code.id).toBe("code-1");
  });

  it("matches case-insensitively and ignores surrounding whitespace", async () => {
    // These come off business cards and out of emails.
    for (const typed of ["driftwood", "  DriftWood  ", "DRIFTWOOD"]) {
      const res = await checkCode(fakeAdmin(code()), typed, { now: NOW });
      expect(res.ok).toBe(true);
    }
  });

  it("refuses an empty code without hitting the database", async () => {
    // No code at all is the common case while someone is still typing; it must
    // not read as a lookup failure of some specific code.
    const res = await checkCode(fakeAdmin(code()), "   ", { now: NOW });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unknown");
  });

  it("refuses an unknown code", async () => {
    const res = await checkCode(fakeAdmin(null), "NOPE", { now: NOW });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unknown");
  });

  it("refuses a deactivated code without deleting its history", async () => {
    const res = await checkCode(fakeAdmin(code({ is_active: false })), "DRIFTWOOD", { now: NOW });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("inactive");
  });

  it("treats the expiry moment itself as expired", async () => {
    const atExpiry = code({ expires_at: NOW.toISOString() });
    const res = await checkCode(fakeAdmin(atExpiry), "DRIFTWOOD", { now: NOW });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("expired");

    const future = code({ expires_at: "2026-08-01T00:00:00Z" });
    expect((await checkCode(fakeAdmin(future), "DRIFTWOOD", { now: NOW })).ok).toBe(true);
  });

  it("stops at the redemption cap — the limit on a leaked code", async () => {
    const capped = code({ max_redemptions: 2 });
    const twice = [{ hotel_id: "h1" }, { hotel_id: "h2" }];
    const res = await checkCode(fakeAdmin(capped, twice), "DRIFTWOOD", { now: NOW });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("exhausted");

    const once = [{ hotel_id: "h1" }];
    expect((await checkCode(fakeAdmin(capped, once), "DRIFTWOOD", { now: NOW })).ok).toBe(true);
  });

  it("ignores the cap when there isn't one", async () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ hotel_id: `h${i}` }));
    const res = await checkCode(fakeAdmin(code({ max_redemptions: null }), many), "DRIFTWOOD", { now: NOW });
    expect(res.ok).toBe(true);
  });

  it("refuses a code the same property already used", async () => {
    // A retried checkout must not let one hotel bank a second trial.
    const res = await checkCode(fakeAdmin(code(), [{ hotel_id: "hotel-1" }]), "DRIFTWOOD", {
      hotelId: "hotel-1",
      now: NOW,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("already_redeemed");
  });

  it("still accepts it for a different property", async () => {
    const res = await checkCode(fakeAdmin(code(), [{ hotel_id: "hotel-other" }]), "DRIFTWOOD", {
      hotelId: "hotel-1",
      now: NOW,
    });
    expect(res.ok).toBe(true);
  });
});

describe("describeCode tells the owner what they're getting", () => {
  it("spells out that a trial still takes a card", async () => {
    const text = describeCode(code({ kind: "trial", trial_days: 7 }));
    expect(text).toContain("7 days free");
    expect(text.toLowerCase()).toContain("card");
  });

  it("distinguishes a time-limited discount from a permanent one", () => {
    const limited = describeCode(
      code({ kind: "percent_off", trial_days: null, percent_off: 20, duration_months: 3 }),
    );
    expect(limited).toContain("20% off");
    expect(limited).toContain("3 months");

    const forever = describeCode(
      code({ kind: "percent_off", trial_days: null, percent_off: 20, duration_months: null }),
    );
    expect(forever).toContain("as long as you stay");
  });

  it("says day, not days, for a one-day trial", () => {
    expect(describeCode(code({ trial_days: 1 }))).toContain("1 day free");
  });
});

describe("checkoutEffectFor", () => {
  it("turns a trial code into trial days", () => {
    expect(checkoutEffectFor(code({ trial_days: 14 }), "month")).toMatchObject({ trialDays: 14 });
  });

  it("reuses an existing coupon rather than asking for another", () => {
    const withCoupon = code({
      kind: "percent_off",
      trial_days: null,
      percent_off: 25,
      stripe_coupon_id: "co_existing",
    });
    expect(checkoutEffectFor(withCoupon, "month")).toEqual({ discountCouponId: "co_existing" });
  });

  it("asks for a coupon the first time a percent code is used", () => {
    const fresh = code({ kind: "percent_off", trial_days: null, percent_off: 25, duration_months: 6 });
    expect(checkoutEffectFor(fresh, "month")).toEqual({
      couponNeeded: { percentOff: 25, duration: "repeating", durationMonths: 6, reusable: true },
    });
  });

  it("states 'forever' outright rather than leaving it to be inferred", () => {
    const forever = code({ kind: "percent_off", trial_days: null, percent_off: 10, duration_months: null });
    expect(checkoutEffectFor(forever, "month")).toEqual({
      couponNeeded: { percentOff: 10, duration: "forever", reusable: true },
    });
  });

});

describe("a duration-limited discount is worth the same on either period", () => {
  const threeMonthsOff = () =>
    code({ kind: "percent_off", trial_days: null, percent_off: 20, duration_months: 3 });

  it("does not hand an annual buyer a whole year of a three-month discount", () => {
    // Stripe counts a repeating coupon in months but applies it per INVOICE, and
    // an annual invoice is twelve of them — so "20% for 3 months" discounted the
    // entire first year, four times the intended giveaway.
    const annual = checkoutEffectFor(threeMonthsOff(), "year");
    expect(annual.couponNeeded).toEqual({ percentOff: 5, duration: "once", reusable: false });
  });

  it("gives the monthly buyer exactly what the code says", () => {
    expect(checkoutEffectFor(threeMonthsOff(), "month").couponNeeded).toEqual({
      percentOff: 20,
      duration: "repeating",
      durationMonths: 3,
      reusable: true,
    });
  });

  it("hands over the same money either way", () => {
    // 20% off 3 of 12 months is 5% off the year. Same cash, different shape.
    const monthlyPrice = 100;
    const monthlyGiven = monthlyPrice * 0.2 * 3;
    const annual = checkoutEffectFor(threeMonthsOff(), "year");
    const annualGiven = monthlyPrice * 12 * ((annual.couponNeeded!.percentOff ?? 0) / 100);
    expect(annualGiven).toBeCloseTo(monthlyGiven, 6);
  });

  it("refuses to cache the rescaled coupon, which is wrong for monthly buyers", () => {
    // One stripe_coupon_id is shared by every later redemption of the code.
    expect(checkoutEffectFor(threeMonthsOff(), "year").couponNeeded?.reusable).toBe(false);
    expect(checkoutEffectFor(threeMonthsOff(), "month").couponNeeded?.reusable).toBe(true);
  });

  it("ignores a cached coupon on the annual path, since it was built for months", () => {
    const cached = code({
      kind: "percent_off", trial_days: null, percent_off: 20, duration_months: 3,
      stripe_coupon_id: "co_monthly_3mo",
    });
    expect(checkoutEffectFor(cached, "year").discountCouponId).toBeUndefined();
    expect(checkoutEffectFor(cached, "month").discountCouponId).toBe("co_monthly_3mo");
  });

  it("leaves a permanent discount and a full-year one alone", () => {
    // Both already mean the same thing on an annual invoice.
    const forever = code({ kind: "percent_off", trial_days: null, percent_off: 15, duration_months: null });
    expect(checkoutEffectFor(forever, "year").couponNeeded?.duration).toBe("forever");

    const twelve = code({ kind: "percent_off", trial_days: null, percent_off: 15, duration_months: 12 });
    expect(checkoutEffectFor(twelve, "year").couponNeeded).toMatchObject({
      percentOff: 15, duration: "repeating", durationMonths: 12,
    });
  });
});

describe("checkCode rejects anything that is not shaped like a code", () => {
  // The gate is the product decision — MAYA throttles demand deliberately — so
  // walking past it is a business bypass, not just a validation slip.
  it.each(["%", "%%", "M%", "%FOUNDER", "_________", "DRIFT%", "%WOOD%"])(
    "refuses the wildcard pattern %j instead of matching a live code",
    async (attempt) => {
      const res = await checkCode(fakeAdmin(code({ code: "DRIFTWOOD" })), attempt);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe("unknown");
    },
  );

  it("gives a wildcard the same answer as a wrong code, so it reveals nothing", async () => {
    const admin = fakeAdmin(code({ code: "DRIFTWOOD" }));
    const wildcard = await checkCode(admin, "%");
    const wrong = await checkCode(admin, "NOPETHISISWRONG");
    expect(wildcard).toEqual(wrong);
  });

  it("still accepts the real code, case-insensitively and with padding", async () => {
    for (const typed of ["DRIFTWOOD", "driftwood", "  DriftWood  "]) {
      expect((await checkCode(fakeAdmin(code({ code: "DRIFTWOOD" })), typed)).ok).toBe(true);
    }
  });

  it("accepts dashes, which real codes use", async () => {
    expect((await checkCode(fakeAdmin(code({ code: "MHS-FOUNDER-1" })), "mhs-founder-1")).ok).toBe(true);
  });

  it("refuses a code too short to be one", async () => {
    expect((await checkCode(fakeAdmin(code({ code: "AB" })), "AB")).ok).toBe(false);
  });
});

describe("displayEffectFor mirrors what checkout will actually build", () => {
  it("passes a trial through", () => {
    expect(displayEffectFor(code({ trial_days: 14 }), "month")).toEqual({ trialDays: 14 });
  });

  it("reports a repeating discount with its month count", () => {
    const pct = code({ kind: "percent_off", trial_days: null, percent_off: 50, duration_months: 3 });
    expect(displayEffectFor(pct, "month")).toEqual({ percentOff: 50, discountDuration: 3 });
  });

  it("reports a forever discount as forever", () => {
    const pct = code({ kind: "percent_off", trial_days: null, percent_off: 20 });
    expect(displayEffectFor(pct, "month")).toEqual({ percentOff: 20, discountDuration: "forever" });
  });

  it("annual rescale shows the once-off percentage the invoice will carry", () => {
    const pct = code({ kind: "percent_off", trial_days: null, percent_off: 50, duration_months: 3 });
    expect(displayEffectFor(pct, "year")).toEqual({ percentOff: 12.5, discountDuration: "once" });
  });

  it("a cached Stripe coupon still yields the shape from the row", () => {
    // The effect only carries the coupon id here; the panel needs the numbers.
    const pct = code({
      kind: "percent_off",
      trial_days: null,
      percent_off: 25,
      duration_months: 6,
      stripe_coupon_id: "coup_1",
    });
    expect(displayEffectFor(pct, "month")).toEqual({ percentOff: 25, discountDuration: 6 });
  });
});

describe("checkoutEffectFor amount_off", () => {
  const fifty = (o: Partial<SignupCode> = {}) =>
    code({ kind: "amount_off", trial_days: null, amount_off_cents: 5000, ...o });

  it("monthly: repeats for the stated months", () => {
    expect(checkoutEffectFor(fifty({ duration_months: 3 }), "month")).toEqual({
      couponNeeded: { amountOffCents: 5000, duration: "repeating", durationMonths: 3, reusable: true },
    });
  });

  it("monthly: forever when no month count", () => {
    expect(checkoutEffectFor(fifty(), "month")).toEqual({
      couponNeeded: { amountOffCents: 5000, duration: "forever", reusable: true },
    });
  });

  it("annual: a limited discount hands over its full total once", () => {
    // 18 months at $50 is $900 whichever period they buy.
    expect(checkoutEffectFor(fifty({ duration_months: 18 }), "year")).toEqual({
      couponNeeded: { amountOffCents: 90000, duration: "once", reusable: false },
    });
  });

  it("annual: forever scales to twelve months per invoice", () => {
    expect(checkoutEffectFor(fifty(), "year")).toEqual({
      couponNeeded: { amountOffCents: 60000, duration: "forever", reusable: false },
    });
  });

  it("reuses a cached coupon for monthly buyers only", () => {
    const cached = fifty({ stripe_coupon_id: "coup_amt" });
    expect(checkoutEffectFor(cached, "month")).toEqual({ discountCouponId: "coup_amt" });
    // The cached coupon is the monthly shape; an annual invoice needs its own.
    expect(checkoutEffectFor(cached, "year").discountCouponId).toBeUndefined();
    expect(checkoutEffectFor(cached, "year").couponNeeded?.reusable).toBe(false);
  });

  it("displayEffectFor mirrors both intervals", () => {
    expect(displayEffectFor(fifty({ duration_months: 3 }), "month")).toEqual({
      amountOffCents: 5000,
      discountDuration: 3,
    });
    expect(displayEffectFor(fifty({ duration_months: 3 }), "year")).toEqual({
      amountOffCents: 15000,
      discountDuration: "once",
    });
  });

  it("describeCode says what the money does", () => {
    expect(describeCode(fifty({ duration_months: 3 }), "month")).toBe(
      "$50.00 off each of your first 3 months.",
    );
    expect(describeCode(fifty(), "month")).toBe("$50.00 off every month, for as long as you stay.");
    expect(describeCode(fifty({ duration_months: 3 }), "year")).toContain("$150.00 off your first invoice");
  });
});
