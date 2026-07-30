import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CODE_PATTERN, describeCode, type SignupCode, type SignupCodeKind } from "@/lib/billing/codes";
import { isEntitled } from "@/lib/billing/sync";
import { formatUsd, MAX_ROOMS, priceCents, type BillingInterval } from "@/lib/billing/tiers";

/**
 * The code desk behind /admin/signup-codes.
 *
 * Reads run under the caller's own session: signup_codes and
 * signup_code_redemptions are RLS'd to is_platform_admin, so the policy is the
 * thing that decides who sees other customers' admin emails — not this file.
 * Writes go the same way on purpose, so a regression in the route guard still
 * hits a closed door at the database.
 *
 * What a code promises is never re-worded here; describeCode() in
 * lib/billing/codes.ts says it once, for the owner typing it and for the admin
 * issuing it.
 */

const CODE_COLUMNS =
  "id, code, kind, trial_days, percent_off, duration_months, fixed_price_cents, fixed_price_interval, tier_rooms_cap, max_redemptions, expires_at, is_active, stripe_coupon_id, notes, created_at";

type StoredCode = SignupCode & { notes: string | null; created_at: string };

export type SignupCodeStatus = "live" | "off" | "expired" | "exhausted";

export type SignupCodeRedemption = {
  id: string;
  email: string;
  hotel_name: string | null;
  redeemed_at: string;
};

export type CodeMoney = {
  paying: number;
  trialing: number;
  /** Per month, after the code's own discount. */
  mrr_cents: number;
  /** Per month at the standard brackets, for comparison. */
  list_mrr_cents: number;
};

export type AdminSignupCodeRow = StoredCode &
  CodeMoney & {
    status: SignupCodeStatus;
    grants: string;
    redemptions: SignupCodeRedemption[];
  };

/**
 * Why a code would be turned away right now, in the same order checkCode
 * decides it. The two must agree, or this list calls a code live while checkout
 * is refusing it.
 */
export function codeStatus(
  code: Pick<SignupCode, "is_active" | "expires_at" | "max_redemptions">,
  redemptionCount: number,
  now: Date,
): SignupCodeStatus {
  if (!code.is_active) return "off";
  if (code.expires_at && new Date(code.expires_at) <= now) return "expired";
  if (code.max_redemptions != null && redemptionCount >= code.max_redemptions) return "exhausted";
  return "live";
}

/**
 * What a code is worth per month, so a code can be judged on what it earned
 * rather than on how often it was typed.
 *
 * Annual is divided back down so monthly and annual properties add into one
 * comparable number, and a percentage code is netted down because that is what
 * reaches the bank. Two things it deliberately does not model: a trial collects
 * nothing yet (counted, kept out of the figure), and a repeating discount that
 * has already run its months is still netted off here. Stripe's invoices remain
 * the record of what was actually collected.
 */
export function rollUpMoney(
  code: Pick<SignupCode, "kind" | "percent_off">,
  subs: { status: string; billed_rooms: number; billing_interval: BillingInterval }[],
): CodeMoney {
  let paying = 0;
  let trialing = 0;
  let listCents = 0;

  for (const sub of subs) {
    if (sub.status === "trialing") {
      trialing += 1;
      continue;
    }
    if (!isEntitled(sub.status)) continue;
    paying += 1;
    const period = priceCents(sub.billed_rooms, sub.billing_interval);
    listCents += sub.billing_interval === "year" ? Math.round(period / 12) : period;
  }

  const pct = code.kind === "percent_off" ? Number(code.percent_off ?? 0) : 0;
  return {
    paying,
    trialing,
    list_mrr_cents: listCents,
    mrr_cents: pct > 0 ? Math.round((listCents * (100 - pct)) / 100) : listCents,
  };
}

export async function listSignupCodes(
  ssr: SupabaseClient,
  opts: { now?: Date } = {},
): Promise<AdminSignupCodeRow[]> {
  const { data, error } = await ssr
    .from("signup_codes")
    .select(CODE_COLUMNS)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`signup_codes: ${error.message}`);

  const codes = (data ?? []) as StoredCode[];
  if (codes.length === 0) return [];
  const ids = codes.map((c) => c.id);

  const [redeemed, subscribed] = await Promise.all([
    ssr
      .from("signup_code_redemptions")
      .select("id, code_id, email, redeemed_at, hotels(name)")
      .in("code_id", ids)
      .order("redeemed_at", { ascending: false }),
    // hotel_subscriptions.signup_code_id is stamped from the checkout session's
    // metadata, which is what ties money back to a code at all.
    ssr
      .from("hotel_subscriptions")
      .select("signup_code_id, status, billed_rooms, billing_interval")
      .in("signup_code_id", ids),
  ]);
  if (redeemed.error) throw new Error(`signup_code_redemptions: ${redeemed.error.message}`);
  if (subscribed.error) throw new Error(`hotel_subscriptions: ${subscribed.error.message}`);

  type RedemptionRow = {
    id: string;
    code_id: string;
    email: string;
    redeemed_at: string;
    hotels: { name: string } | { name: string }[] | null;
  };
  const byCode = new Map<string, SignupCodeRedemption[]>();
  for (const row of (redeemed.data ?? []) as RedemptionRow[]) {
    const hotel = Array.isArray(row.hotels) ? row.hotels[0] : row.hotels;
    const list = byCode.get(row.code_id) ?? [];
    list.push({
      id: row.id,
      email: row.email,
      // Null once the hotel is gone; the email is denormalized precisely so the
      // row still says something after that.
      hotel_name: hotel?.name ?? null,
      redeemed_at: row.redeemed_at,
    });
    byCode.set(row.code_id, list);
  }

  type SubRow = {
    signup_code_id: string;
    status: string;
    billed_rooms: number;
    billing_interval: BillingInterval;
  };
  const subsByCode = new Map<string, SubRow[]>();
  for (const row of (subscribed.data ?? []) as SubRow[]) {
    const list = subsByCode.get(row.signup_code_id) ?? [];
    list.push(row);
    subsByCode.set(row.signup_code_id, list);
  }

  const now = opts.now ?? new Date();
  return codes.map((code) => {
    const redemptions = byCode.get(code.id) ?? [];
    return {
      ...code,
      ...rollUpMoney(code, subsByCode.get(code.id) ?? []),
      status: codeStatus(code, redemptions.length, now),
      grants: describeCode(code),
      redemptions,
    };
  });
}

/** Head count for the Command Center tile — no redemption history hauled in. */
export async function countSignupCodes(ssr: SupabaseClient): Promise<number> {
  const { count, error } = await ssr
    .from("signup_codes")
    .select("id", { count: "exact", head: true });
  if (error) throw new Error(`signup_codes: ${error.message}`);
  return count ?? 0;
}

export type SignupCodeInput = {
  code: string;
  kind: SignupCodeKind;
  trial_days: number | null;
  percent_off: number | null;
  duration_months: number | null;
  fixed_price_cents: number | null;
  fixed_price_interval: BillingInterval | null;
  tier_rooms_cap: number | null;
  max_redemptions: number | null;
  expires_at: string | null;
  notes: string | null;
};

export type ParsedSignupCode = { ok: true; row: SignupCodeInput } | { ok: false; error: string };

// The shape lives in lib/billing/codes.ts, which is also where it is enforced on
// redemption. Two copies could drift into a code this accepts but checkCode
// refuses to look up.

/** Longer than this stops being a trial, and Stripe won't take it either. */
const MAX_TRIAL_DAYS = 730;

function wholeNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isInteger(v) && v > 0 ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  return null;
}

const isBlank = (v: unknown): boolean =>
  v == null || (typeof v === "string" && v.trim() === "");

/**
 * Validates a code the way chk_signup_code_shape does, before Postgres gets a
 * chance to answer in constraint names. Each kind carries its own fields and
 * nothing else's — the fields belonging to the other kinds are nulled rather
 * than trusted, so a form that kept stale state can't smuggle a second grant in.
 */
export function parseSignupCodeInput(body: unknown, now = new Date()): ParsedSignupCode {
  const b = (body ?? {}) as Record<string, unknown>;

  // Stored casing is display only — lookups match on lower(code) — so settle on
  // one and print that.
  const code = typeof b.code === "string" ? b.code.trim().toUpperCase() : "";
  if (!CODE_PATTERN.test(code)) {
    return {
      ok: false,
      error:
        "A code is 3–40 characters of letters, numbers and dashes, starting with a letter or number.",
    };
  }

  const kind = b.kind;
  if (kind !== "trial" && kind !== "percent_off" && kind !== "fixed_price") {
    return { ok: false, error: "Say what the code does: trial, percent_off or fixed_price." };
  }

  let maxRedemptions: number | null = null;
  if (!isBlank(b.max_redemptions)) {
    maxRedemptions = wholeNumber(b.max_redemptions);
    if (maxRedemptions === null) {
      return { ok: false, error: "A redemption cap has to be a whole number above zero." };
    }
  }

  let expiresAt: string | null = null;
  if (!isBlank(b.expires_at)) {
    const when = new Date(String(b.expires_at));
    if (Number.isNaN(when.getTime())) {
      return { ok: false, error: "That expiry date isn't a date." };
    }
    if (when <= now) {
      return { ok: false, error: "That expiry has already passed, so the code would be born dead." };
    }
    expiresAt = when.toISOString();
  }

  const notes = typeof b.notes === "string" && b.notes.trim() !== "" ? b.notes.trim() : null;

  const shell: SignupCodeInput = {
    code,
    kind,
    trial_days: null,
    percent_off: null,
    duration_months: null,
    fixed_price_cents: null,
    fixed_price_interval: null,
    tier_rooms_cap: null,
    max_redemptions: maxRedemptions,
    expires_at: expiresAt,
    notes,
  };

  if (kind === "trial") {
    const days = wholeNumber(b.trial_days);
    if (days === null) return { ok: false, error: "How many days is the trial?" };
    if (days > MAX_TRIAL_DAYS) {
      return { ok: false, error: `Trials cap at ${MAX_TRIAL_DAYS} days.` };
    }
    return { ok: true, row: { ...shell, trial_days: days } };
  }

  if (kind === "percent_off") {
    // Only a number or a numeric string. Number(true) is 1, so a stray boolean
    // would otherwise create a silent 1%-off code.
    const pct =
      typeof b.percent_off === "number"
        ? b.percent_off
        : typeof b.percent_off === "string"
          ? Number(b.percent_off)
          : NaN;
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      return { ok: false, error: "A percentage off runs from just above 0 to 100." };
    }
    // The column is numeric(5,2); anything finer would be rounded on the way in
    // and the coupon Stripe gets would not be the number that was typed.
    if (Math.round(pct * 100) !== pct * 100) {
      return { ok: false, error: "Percentages go to two decimal places." };
    }
    let months: number | null = null;
    if (!isBlank(b.duration_months)) {
      months = wholeNumber(b.duration_months);
      if (months === null) {
        return { ok: false, error: "Leave the number of months blank for a discount that never ends." };
      }
    }
    return { ok: true, row: { ...shell, percent_off: pct, duration_months: months } };
  }

  const interval = b.fixed_price_interval;
  if (interval !== "month" && interval !== "year") {
    return { ok: false, error: "Say whether the fixed price is per month or per year." };
  }
  // Checkout honours a fixed price by billing the room count the deal was struck
  // at (checkoutEffectFor -> roomsOverride). Without that cap the property is
  // billed its real room count at standard rates while the code goes on
  // promising a fixed number, so the cap is not optional here even though the
  // column allows null.
  const rooms = wholeNumber(b.tier_rooms_cap);
  if (rooms === null) {
    return {
      ok: false,
      error:
        "A fixed-price deal needs the room count it was agreed at — that is the number checkout bills.",
    };
  }
  if (rooms > MAX_ROOMS) {
    return { ok: false, error: `Room counts stop at ${MAX_ROOMS}.` };
  }
  const bracket = priceCents(rooms, interval);
  if (!isBlank(b.fixed_price_cents)) {
    const cents = wholeNumber(b.fixed_price_cents);
    if (cents !== bracket) {
      return {
        ok: false,
        error: `${rooms} rooms bills ${formatUsd(bracket)} per ${interval}, so that is what this code can promise. Change the price or change the room count.`,
      };
    }
  }
  return {
    ok: true,
    row: {
      ...shell,
      fixed_price_cents: bracket,
      fixed_price_interval: interval,
      tier_rooms_cap: rooms,
    },
  };
}

export async function createSignupCode(
  ssr: SupabaseClient,
  row: SignupCodeInput,
  actorUserId: string,
): Promise<{ id: string; code: string; grants: string }> {
  const { data, error } = await ssr
    .from("signup_codes")
    .insert({ ...row, created_by: actorUserId })
    .select(CODE_COLUMNS)
    .single();

  if (error) {
    // uq_signup_codes_code indexes lower(code), so DRIFTWOOD and driftwood are
    // one code — worth saying, rather than reporting a unique violation.
    if (error.code === "23505") {
      throw new Error(`${row.code} already exists — codes are matched case-insensitively.`);
    }
    throw new Error(`Could not create that code: ${error.message}`);
  }

  const created = data as StoredCode;
  await logCodeEvent(ssr, "signup_code.created", created.id, {
    code: created.code,
    kind: created.kind,
  });
  return { id: created.id, code: created.code, grants: describeCode(created) };
}

/**
 * Turn a code off, never delete it. signup_code_redemptions cascades on delete
 * and hotel_subscriptions.signup_code_id nulls out, so dropping a row erases
 * exactly the report the code exists to feed — the same reason a retired pricing
 * rule is paused instead of removed. Returns null when there is no such code.
 */
export async function setSignupCodeActive(
  ssr: SupabaseClient,
  codeId: string,
  isActive: boolean,
): Promise<{ code: string } | null> {
  const { data, error } = await ssr
    .from("signup_codes")
    .update({ is_active: isActive })
    .eq("id", codeId)
    .select("id, code")
    .maybeSingle();
  if (error) throw new Error(`Could not update that code: ${error.message}`);
  if (!data) return null;

  const row = data as { id: string; code: string };
  await logCodeEvent(
    ssr,
    isActive ? "signup_code.reactivated" : "signup_code.deactivated",
    row.id,
    { code: row.code },
  );
  return { code: row.code };
}

/**
 * Audit lines are written with the admin's own session: platform_log_event
 * stamps auth.uid() as the actor, so a service-role call would record nobody
 * (and its own is_platform_admin() check would refuse). A lost audit line is
 * not worth failing the write that already happened, but it is worth logging.
 */
async function logCodeEvent(
  ssr: SupabaseClient,
  eventType: string,
  codeId: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const { error } = await ssr.rpc("platform_log_event", {
    p_event_type: eventType,
    p_entity_type: "signup_code",
    p_entity_id: codeId,
    p_detail: detail,
  });
  if (error) {
    console.error(JSON.stringify({ fn: "logCodeEvent", eventType, error: error.message }));
  }
}
