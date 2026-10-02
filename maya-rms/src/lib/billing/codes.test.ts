import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  addMonthsUtc,
  checkCode,
  checkoutEffectFor,
  coverTrial,
  describeCode,
  displayEffectFor,
  rejectionMessage,
  type SignupCode,
} from "./codes";

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

describe("a discount code can open with a free run", () => {
  const sevenThen75 = () =>
    code({
      kind: "percent_off",
      trial_days: 7,
      percent_off: 75,
      duration_months: null,
    });

  it("carries both the trial and the coupon into checkout", () => {
    expect(checkoutEffectFor(sevenThen75(), "month")).toEqual({
      trialDays: 7,
      couponNeeded: { percentOff: 75, duration: "forever", reusable: true },
    });
  });

  it("keeps the trial when the coupon is already cached", () => {
    const cached = code({
      kind: "percent_off",
      trial_days: 7,
      percent_off: 75,
      stripe_coupon_id: "coup_75",
    });
    expect(checkoutEffectFor(cached, "month")).toEqual({
      trialDays: 7,
      discountCouponId: "coup_75",
    });
  });

  it("keeps the trial through the annual rescale", () => {
    const limited = code({ kind: "percent_off", trial_days: 7, percent_off: 50, duration_months: 3 });
    expect(checkoutEffectFor(limited, "year")).toMatchObject({ trialDays: 7 });
  });

  it("carries both onto a dollars-off code too", () => {
    const amt = code({
      kind: "amount_off",
      trial_days: 14,
      amount_off_cents: 5000,
      percent_off: null,
      duration_months: 6,
    });
    expect(checkoutEffectFor(amt, "month")).toEqual({
      trialDays: 14,
      couponNeeded: { amountOffCents: 5000, duration: "repeating", durationMonths: 6, reusable: true },
    });
  });

  it("a discount with no trial is unchanged", () => {
    const plain = code({ kind: "percent_off", trial_days: null, percent_off: 75 });
    expect(checkoutEffectFor(plain, "month")).toEqual({
      couponNeeded: { percentOff: 75, duration: "forever", reusable: true },
    });
  });

  it("describes the free run first, then the discount", () => {
    expect(describeCode(sevenThen75(), "month")).toBe(
      "7 days free, then 75% off, for as long as you stay.",
    );
  });

  it("surfaces both to the price panel", () => {
    expect(displayEffectFor(sevenThen75(), "month")).toEqual({
      trialDays: 7,
      percentOff: 75,
      discountDuration: "forever",
    });
  });
});

describe("a restart gets no free days, whatever the code says", () => {
  // Checkout grants a restart no trial of any kind. The wording and the panel
  // must not promise days Stripe will not give; the discount still counts.
  it("says plainly that a trial code's free days don't apply", () => {
    expect(describeCode(code({ trial_days: 30 }), "month", { restart: true })).toBe(
      "This code's 30 free days don't apply to a restart, so it doesn't change your price.",
    );
    expect(describeCode(code({ trial_days: 1 }), "month", { restart: true })).toBe(
      "This code's 1 free day doesn't apply to a restart, so it doesn't change your price.",
    );
  });

  it("describes only the discount of a code that also opens with free days", () => {
    const sevenThen75 = code({ kind: "percent_off", trial_days: 7, percent_off: 75 });
    expect(describeCode(sevenThen75, "month", { restart: true })).toBe("75% off, for as long as you stay.");
    const amt = code({ kind: "amount_off", trial_days: 14, amount_off_cents: 5000, duration_months: 6 });
    expect(describeCode(amt, "month", { restart: true })).toBe("$50.00 off each of your first 6 months.");
  });

  it("leaves the trial out of what the panel prices from", () => {
    expect(displayEffectFor(code({ trial_days: 30 }), "month", { restart: true })).toEqual({});
    const sevenThen75 = code({ kind: "percent_off", trial_days: 7, percent_off: 75 });
    expect(displayEffectFor(sevenThen75, "month", { restart: true })).toEqual({
      percentOff: 75,
      discountDuration: "forever",
    });
  });

  it("changes nothing for a first signup", () => {
    expect(describeCode(code({ trial_days: 30 }), "month")).toMatch(/^30 days free/);
    expect(displayEffectFor(code({ trial_days: 30 }), "month")).toEqual({ trialDays: 30 });
  });

  it("never puts an em dash in front of the owner", () => {
    const shapes = [
      code(),
      code({ kind: "percent_off", trial_days: 7, percent_off: 20, duration_months: 3 }),
      code({ kind: "percent_off", trial_days: null, percent_off: 20, duration_months: null }),
      code({ kind: "amount_off", trial_days: 14, amount_off_cents: 2500, duration_months: 3 }),
      code({ kind: "amount_off", trial_days: null, amount_off_cents: 2500, duration_months: null }),
    ];
    for (const c of shapes) {
      for (const interval of ["month", "year"] as const) {
        for (const restart of [false, true]) {
          expect(describeCode(c, interval, { restart }), `${c.kind} ${interval} ${restart}`).not.toContain("\u2014");
        }
      }
    }
    for (const reason of ["unknown", "inactive", "expired", "exhausted", "already_redeemed"] as const) {
      expect(rejectionMessage(reason)).not.toContain("\u2014");
    }
    expect(rejectionMessage("unknown")).toBe("We don't recognize that code. Check it for typos.");
    expect(describeCode(shapes[1], "year")).toBe(
      "7 days free, then 20% off your first 3 months, taken as 5% off your first year, which is the same saving.",
    );
  });

  it("carries the restart wording through checkCode", async () => {
    const check = await checkCode(fakeAdmin(code({ trial_days: 30 })), "DRIFTWOOD", { now: NOW, restart: true });
    expect(check).toMatchObject({
      ok: true,
      describe: "This code's 30 free days don't apply to a restart, so it doesn't change your price.",
    });
  });
});

describe("a limited discount still reaches its paid invoices after free days", () => {
  // Stripe counts a coupon from signup, and with a trial the first invoice is
  // $0. A "once" coupon is likely spent on that $0 invoice, and a repeating one
  // loses the months the trial took. Checkout passes the free days it actually
  // grants, and the coupon is stretched to cover them.
  const DAY = 86_400_000;
  const halfOffSix = (o: Partial<SignupCode> = {}) =>
    code({ kind: "percent_off", trial_days: 30, percent_off: 50, duration_months: 6, ...o });

  it("yearly: repeats past the trial instead of a once-off coupon the $0 invoice could use up", () => {
    const effect = checkoutEffectFor(halfOffSix(), "year", { trialDays: 30, now: NOW });
    expect(effect).toEqual({
      trialDays: 30,
      couponNeeded: { percentOff: 25, duration: "repeating", durationMonths: 3, reusable: false },
    });
  });

  it("yearly dollars off the same way", () => {
    const amt = code({ kind: "amount_off", trial_days: 7, percent_off: null, amount_off_cents: 5000, duration_months: 6 });
    expect(checkoutEffectFor(amt, "year", { trialDays: 7, now: NOW }).couponNeeded).toEqual({
      amountOffCents: 30000,
      duration: "repeating",
      durationMonths: 2,
      reusable: false,
    });
  });

  it("yearly: covers the first paid invoice and never the next, for every trial length Stripe allows", () => {
    for (const startIso of ["2026-01-31T09:00:00Z", "2026-02-28T23:00:00Z", "2026-07-29T12:00:00Z", "2027-12-15T00:00:00Z"]) {
      const start = new Date(startIso);
      for (let days = 1; days <= 730; days += 1) {
        const spec = coverTrial({ percentOff: 10, duration: "once", reusable: false }, "year", { trialDays: days, now: start });
        const end = addMonthsUtc(start, spec.durationMonths!).getTime();
        const firstPaid = start.getTime() + days * DAY;
        const nextYear = addMonthsUtc(new Date(firstPaid), 12).getTime();
        expect(end - firstPaid).toBeGreaterThanOrEqual(28 * DAY);
        expect(end).toBeLessThan(nextYear);
      }
    }
  });

  it("yearly: a code longer than a year keeps reaching the same number of yearly invoices", () => {
    const eighteen = halfOffSix({ duration_months: 18, trial_days: 14 });
    expect(checkoutEffectFor(eighteen, "year", { trialDays: 14, now: NOW }).couponNeeded).toMatchObject({
      duration: "repeating",
      durationMonths: 14,
      reusable: false,
    });
  });

  it("monthly: under four weeks free changes nothing, and a cached coupon is still used", () => {
    const cached = halfOffSix({ trial_days: 14, stripe_coupon_id: "co_cached" });
    expect(checkoutEffectFor(cached, "month", { trialDays: 14, now: NOW })).toEqual({
      trialDays: 14,
      discountCouponId: "co_cached",
    });
    expect(coverTrial({ percentOff: 50, duration: "repeating", durationMonths: 6, reusable: true }, "month", { trialDays: 27, now: NOW }))
      .toEqual({ percentOff: 50, duration: "repeating", durationMonths: 6, reusable: true });
  });

  it("monthly: a 30-day trial from a 31-day month needs nothing extra", () => {
    const spec = coverTrial(
      { percentOff: 50, duration: "repeating", durationMonths: 3, reusable: true },
      "month",
      { trialDays: 30, now: new Date("2026-01-15T10:00:00Z") },
    );
    expect(spec).toEqual({ percentOff: 50, duration: "repeating", durationMonths: 3, reusable: true });
  });

  it("monthly: a 60-day trial adds the months it took, and is never cached", () => {
    const effect = checkoutEffectFor(halfOffSix({ trial_days: 60, stripe_coupon_id: "co_cached" }), "month", {
      trialDays: 60,
      now: new Date("2026-03-10T10:00:00Z"),
    });
    expect(effect.discountCouponId).toBeUndefined();
    // Free until May 9, then six paid months: May 9 to Oct 9. Seven months
    // from March 10 ends on October 10, after the sixth and before the seventh.
    expect(effect.couponNeeded).toEqual({ percentOff: 50, duration: "repeating", durationMonths: 7, reusable: false });
  });

  it("monthly: every promised month is discounted, at most one more, whatever the start date and trial", () => {
    // Paid invoices fall on the trial's end and monthly after it. The coupon
    // runs from signup. Checked for a checkout completed up to a day after it
    // was opened too, which near a month end is where a month went missing.
    for (let day = 0; day < 731; day += 1) {
      const opened = new Date(Date.parse("2026-01-01T15:30:00Z") + day * DAY);
      for (const days of [28, 29, 30, 31, 45, 59, 60, 61, 90, 365]) {
        for (const months of [1, 3, 6]) {
          const spec = coverTrial(
            { percentOff: 20, duration: "repeating", durationMonths: months, reusable: true },
            "month",
            { trialDays: days, now: opened },
          );
          for (const lateMs of [0, 3600_000, 6 * 3600_000, 12 * 3600_000, 23 * 3600_000, 24 * 3600_000]) {
            const start = new Date(opened.getTime() + lateMs);
            const trialEnd = new Date(start.getTime() + days * DAY);
            const end = addMonthsUtc(start, spec.durationMonths!).getTime();
            expect(end).toBeGreaterThan(addMonthsUtc(trialEnd, months - 1).getTime());
            expect(end).toBeLessThanOrEqual(addMonthsUtc(trialEnd, months + 1).getTime());
          }
        }
      }
    }
  });

  it("leaves forever alone, and a restart (no free days) alone", () => {
    const forever = halfOffSix({ duration_months: null });
    expect(checkoutEffectFor(forever, "year", { trialDays: 30, now: NOW }).couponNeeded).toMatchObject({ duration: "forever" });
    expect(checkoutEffectFor(halfOffSix(), "year", { trialDays: 0, now: NOW }).couponNeeded).toEqual({
      percentOff: 25,
      duration: "once",
      reusable: false,
    });
  });

  it("does not change what the screens describe", () => {
    expect(displayEffectFor(halfOffSix(), "year")).toMatchObject({ trialDays: 30, percentOff: 25, discountDuration: "once" });
    expect(displayEffectFor(halfOffSix(), "month")).toMatchObject({ trialDays: 30, percentOff: 50, discountDuration: 6 });
  });

  it("moves a billing date the way Stripe does at month ends", () => {
    expect(addMonthsUtc(new Date("2026-01-31T09:00:00Z"), 1).toISOString()).toBe("2026-02-28T09:00:00.000Z");
    expect(addMonthsUtc(new Date("2026-01-31T09:00:00Z"), 2).toISOString()).toBe("2026-03-31T09:00:00.000Z");
    expect(addMonthsUtc(new Date("2027-12-15T00:00:00Z"), 3).toISOString()).toBe("2028-03-15T00:00:00.000Z");
  });
});
