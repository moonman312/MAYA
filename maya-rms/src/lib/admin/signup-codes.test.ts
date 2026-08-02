/**
 * Tests for the code desk's two jobs: refusing a malformed code before Postgres
 * has to, and reporting what a code actually did.
 *
 * chk_signup_code_shape is the real gate; these pin that the API reaches the
 * same verdict first, in a sentence Jake can act on, and that a code carrying a
 * field belonging to another kind loses it rather than smuggling a second grant
 * into checkout.
 */
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  codeStatus,
  listSignupCodes,
  parseSignupCodeInput,
  rollUpMoney,
} from "./signup-codes";

const NOW = new Date("2026-07-29T12:00:00Z");

function parse(body: Record<string, unknown>) {
  return parseSignupCodeInput(body, NOW);
}

/** Every table the list reads, answered from a seed. */
function fakeSsr(seed: Record<string, Record<string, unknown>[]>) {
  const client = {
    from: (table: string) => {
      const api = {
        select: () => api,
        in: () => api,
        order: () => api,
        then: (resolve: (v: { data: unknown; error: null }) => void) =>
          Promise.resolve({ data: seed[table] ?? [], error: null }).then(resolve),
      };
      return api;
    },
  };
  return client as unknown as SupabaseClient;
}

describe("parseSignupCodeInput: the code itself", () => {
  it("settles on one casing, since lookups ignore it anyway", () => {
    const res = parse({ code: "  driftwood-10 ", kind: "trial", trial_days: 7 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.row.code).toBe("DRIFTWOOD-10");
  });

  it("refuses codes nobody could read off a card", () => {
    for (const code of ["", "AB", "WITH SPACE", "-LEADING", "e".repeat(41)]) {
      const res = parse({ code, kind: "trial", trial_days: 7 });
      expect(res.ok).toBe(false);
    }
  });

  it("insists on a kind", () => {
    const res = parse({ code: "DRIFTWOOD", kind: "free_forever", trial_days: 7 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("trial");
  });
});

describe("parseSignupCodeInput: each kind carries only its own fields", () => {
  it("keeps trial days and nulls the rest", () => {
    const res = parse({ code: "TRIAL30", kind: "trial", trial_days: 30, percent_off: 50 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.row).toMatchObject({
      trial_days: 30,
      percent_off: null,
      fixed_price_cents: null,
      fixed_price_interval: null,
      tier_rooms_cap: null,
    });
  });

  it("drops a stale trial length off a percent-off code", () => {
    // A form that switched kinds without clearing state would otherwise grant
    // both a discount and a free month.
    const res = parse({ code: "TWENTY", kind: "percent_off", percent_off: 20, trial_days: 14 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.row.trial_days).toBeNull();
  });

  it("reads a blank duration as forever, not as zero months", () => {
    const forever = parse({ code: "FOREVER", kind: "percent_off", percent_off: 10, duration_months: "" });
    expect(forever.ok).toBe(true);
    if (forever.ok) expect(forever.row.duration_months).toBeNull();

    const limited = parse({ code: "THREE", kind: "percent_off", percent_off: 10, duration_months: 3 });
    if (limited.ok) expect(limited.row.duration_months).toBe(3);
  });

  it("refuses a percentage outside 0–100 and one finer than the column stores", () => {
    for (const percent_off of [0, -5, 101, 12.345]) {
      expect(parse({ code: "PCT", kind: "percent_off", percent_off }).ok).toBe(false);
    }
    expect(parse({ code: "PCT", kind: "percent_off", percent_off: 12.5 }).ok).toBe(true);
  });

  it("asks for a trial length rather than writing a code that grants nothing", () => {
    const res = parse({ code: "TRIAL", kind: "trial" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("days");
  });

  it("caps a trial before Stripe would refuse it", () => {
    expect(parse({ code: "TRIAL", kind: "trial", trial_days: 730 }).ok).toBe(true);
    expect(parse({ code: "TRIAL", kind: "trial", trial_days: 731 }).ok).toBe(false);
  });
});

describe("parseSignupCodeInput: the retired fixed_price kind", () => {
  it("is refused like any unknown kind", () => {
    const res = parse({ code: "DEAL", kind: "fixed_price", fixed_price_interval: "month", tier_rooms_cap: 40 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("trial, percent_off or amount_off");
  });
});

describe("parseSignupCodeInput: limits and notes", () => {
  it("takes a cap and an expiry, and normalises the expiry to an instant", () => {
    const res = parse({
      code: "LIMITED",
      kind: "trial",
      trial_days: 7,
      max_redemptions: 10,
      expires_at: "2026-08-30T23:59:59Z",
      notes: "  Gave this to the Driftwood GM in Austin  ",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.row.max_redemptions).toBe(10);
    expect(res.row.expires_at).toBe("2026-08-30T23:59:59.000Z");
    expect(res.row.notes).toBe("Gave this to the Driftwood GM in Austin");
  });

  it("reads blanks as no cap, no expiry, no note", () => {
    const res = parse({ code: "OPEN", kind: "trial", trial_days: 7, max_redemptions: "", expires_at: "", notes: "  " });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.row.max_redemptions).toBeNull();
    expect(res.row.expires_at).toBeNull();
    expect(res.row.notes).toBeNull();
  });

  it("refuses an expiry that has already passed", () => {
    const res = parse({ code: "STALE", kind: "trial", trial_days: 7, expires_at: "2026-01-01" });
    expect(res.ok).toBe(false);
  });

  it("refuses a cap that isn't a whole number of redemptions", () => {
    expect(parse({ code: "CAP", kind: "trial", trial_days: 7, max_redemptions: 0 }).ok).toBe(false);
    expect(parse({ code: "CAP", kind: "trial", trial_days: 7, max_redemptions: 2.5 }).ok).toBe(false);
  });
});

describe("codeStatus agrees with what checkout would say", () => {
  const base = { is_active: true, expires_at: null, max_redemptions: null };

  it("calls a usable code live", () => {
    expect(codeStatus(base, 0, NOW)).toBe("live");
  });

  it("reports off ahead of expired, the order checkCode refuses in", () => {
    const both = { is_active: false, expires_at: "2026-01-01T00:00:00Z", max_redemptions: null };
    expect(codeStatus(both, 0, NOW)).toBe("off");
  });

  it("treats the expiry moment itself as expired", () => {
    expect(codeStatus({ ...base, expires_at: NOW.toISOString() }, 0, NOW)).toBe("expired");
  });

  it("calls a code used up once the cap is reached", () => {
    expect(codeStatus({ ...base, max_redemptions: 2 }, 2, NOW)).toBe("exhausted");
    expect(codeStatus({ ...base, max_redemptions: 2 }, 1, NOW)).toBe("live");
  });
});

describe("rollUpMoney: what the code earned, not how often it was typed", () => {
  const trial = { kind: "trial" as const, percent_off: null, amount_off_cents: null };

  it("adds monthly subscriptions at their bracket", () => {
    const money = rollUpMoney(trial, [
      { status: "active", billed_rooms: 40, billing_interval: "month" },
      { status: "past_due", billed_rooms: 20, billing_interval: "month" },
    ]);
    expect(money).toMatchObject({ paying: 2, trialing: 0, mrr_cents: 20000 + 11000 });
  });

  it("divides an annual subscription back down so the numbers can be added", () => {
    const money = rollUpMoney(trial, [{ status: "active", billed_rooms: 40, billing_interval: "year" }]);
    expect(money.mrr_cents).toBe(18000);
  });

  it("counts a trial without letting it claim revenue it hasn't earned", () => {
    const money = rollUpMoney(trial, [{ status: "trialing", billed_rooms: 40, billing_interval: "month" }]);
    expect(money).toMatchObject({ paying: 0, trialing: 1, mrr_cents: 0 });
  });

  it("ignores subscriptions that stopped paying", () => {
    const money = rollUpMoney(trial, [
      { status: "canceled", billed_rooms: 40, billing_interval: "month" },
      { status: "unpaid", billed_rooms: 40, billing_interval: "month" },
    ]);
    expect(money).toMatchObject({ paying: 0, mrr_cents: 0, list_mrr_cents: 0 });
  });

  it("nets a percent-off code down, and keeps the list figure alongside it", () => {
    const money = rollUpMoney({ kind: "percent_off", percent_off: 25, amount_off_cents: null }, [
      { status: "active", billed_rooms: 40, billing_interval: "month" },
    ]);
    expect(money).toMatchObject({ mrr_cents: 15000, list_mrr_cents: 20000 });
  });
});

describe("listSignupCodes", () => {
  const codes = [
    {
      id: "code-1",
      code: "DRIFTWOOD",
      kind: "percent_off",
      trial_days: null,
      percent_off: 25,
      duration_months: 3,
      fixed_price_cents: null,
      fixed_price_interval: null,
      tier_rooms_cap: null,
      max_redemptions: 2,
      expires_at: null,
      is_active: true,
      stripe_coupon_id: null,
      notes: "Gave this to the Driftwood GM in Austin",
      created_at: "2026-07-01T00:00:00Z",
    },
    {
      id: "code-2",
      code: "MHSFOUNDER",
      kind: "trial",
      trial_days: 14,
      percent_off: null,
      duration_months: null,
      fixed_price_cents: null,
      fixed_price_interval: null,
      tier_rooms_cap: null,
      max_redemptions: null,
      expires_at: null,
      is_active: false,
      stripe_coupon_id: null,
      notes: null,
      created_at: "2026-06-01T00:00:00Z",
    },
  ];

  const seed = {
    signup_codes: codes,
    signup_code_redemptions: [
      {
        id: "r1",
        code_id: "code-1",
        email: "gm@driftwood.com",
        redeemed_at: "2026-07-10T00:00:00Z",
        hotels: { name: "Driftwood Austin" },
      },
      {
        id: "r2",
        code_id: "code-1",
        email: "owner@sunsetbay.com",
        redeemed_at: "2026-07-05T00:00:00Z",
        // PostgREST hands an embed back as an array in some shapes.
        hotels: [{ name: "Sunset Bay" }],
      },
      { id: "r3", code_id: "code-2", email: "gone@example.com", redeemed_at: "2026-06-02T00:00:00Z", hotels: null },
    ],
    hotel_subscriptions: [
      { signup_code_id: "code-1", status: "active", billed_rooms: 40, billing_interval: "month" },
      { signup_code_id: "code-1", status: "trialing", billed_rooms: 20, billing_interval: "month" },
      { signup_code_id: "code-2", status: "canceled", billed_rooms: 20, billing_interval: "month" },
    ],
  };

  it("hands each code its own redemptions, with the admin's email and the hotel", async () => {
    const rows = await listSignupCodes(fakeSsr(seed), { now: NOW });
    const driftwood = rows.find((r) => r.id === "code-1");
    expect(driftwood?.redemptions).toEqual([
      { id: "r1", email: "gm@driftwood.com", hotel_name: "Driftwood Austin", redeemed_at: "2026-07-10T00:00:00Z" },
      { id: "r2", email: "owner@sunsetbay.com", hotel_name: "Sunset Bay", redeemed_at: "2026-07-05T00:00:00Z" },
    ]);
  });

  it("keeps a redemption whose hotel is gone, since the email is the point", async () => {
    const rows = await listSignupCodes(fakeSsr(seed), { now: NOW });
    expect(rows.find((r) => r.id === "code-2")?.redemptions[0]).toMatchObject({
      email: "gone@example.com",
      hotel_name: null,
    });
  });

  it("describes and prices each code without re-wording what it grants", async () => {
    const rows = await listSignupCodes(fakeSsr(seed), { now: NOW });
    const driftwood = rows.find((r) => r.id === "code-1");
    expect(driftwood?.grants).toContain("25% off");
    expect(driftwood).toMatchObject({ paying: 1, trialing: 1, mrr_cents: 15000, list_mrr_cents: 20000 });
  });

  it("marks a code that hit its cap as used up, and a switched-off one as off", async () => {
    const rows = await listSignupCodes(fakeSsr(seed), { now: NOW });
    expect(rows.find((r) => r.id === "code-1")?.status).toBe("exhausted");
    expect(rows.find((r) => r.id === "code-2")?.status).toBe("off");
  });

  it("skips the redemption and subscription reads when there are no codes", async () => {
    expect(await listSignupCodes(fakeSsr({ signup_codes: [] }), { now: NOW })).toEqual([]);
  });
});

describe("parseSignupCodeInput amount_off", () => {
  const base = { code: "DOLLARS", kind: "amount_off" };

  it("accepts an amount with months", () => {
    const parsed = parseSignupCodeInput({ ...base, amount_off_cents: 5000, duration_months: 3 });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.row).toMatchObject({
        kind: "amount_off",
        amount_off_cents: 5000,
        duration_months: 3,
        percent_off: null,
        fixed_price_cents: null,
      });
    }
  });

  it("blank months means forever", () => {
    const parsed = parseSignupCodeInput({ ...base, amount_off_cents: 5000, duration_months: "" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.row.duration_months).toBeNull();
  });

  it("refuses a missing or zero amount", () => {
    expect(parseSignupCodeInput({ ...base }).ok).toBe(false);
    expect(parseSignupCodeInput({ ...base, amount_off_cents: 0 }).ok).toBe(false);
  });

  it("caps months at ten years — past that it's a forever code", () => {
    const parsed = parseSignupCodeInput({ ...base, amount_off_cents: 5000, duration_months: 121 });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("blank");
  });

  it("refuses an amount above the biggest possible bill", () => {
    const parsed = parseSignupCodeInput({ ...base, amount_off_cents: 130000 });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("biggest possible monthly bill");
  });
});

describe("rollUpMoney amount_off", () => {
  const twentyOff = { kind: "amount_off" as const, percent_off: null, amount_off_cents: 2000 };

  it("nets the amount off each paying property", () => {
    const money = rollUpMoney(twentyOff, [
      { status: "active", billed_rooms: 40, billing_interval: "month" },
      { status: "active", billed_rooms: 20, billing_interval: "month" },
    ]);
    expect(money.list_mrr_cents).toBe(20000 + 11000);
    expect(money.mrr_cents).toBe(18000 + 9000);
  });

  it("floors a single property at zero instead of netting other properties down", () => {
    const bigOff = { ...twentyOff, amount_off_cents: 100000 };
    const money = rollUpMoney(bigOff, [
      { status: "active", billed_rooms: 20, billing_interval: "month" },
      { status: "active", billed_rooms: 40, billing_interval: "month" },
    ]);
    // $110 and $200 bills against $1,000 off: each floors at zero on its own.
    expect(money.mrr_cents).toBe(0);
  });
});
