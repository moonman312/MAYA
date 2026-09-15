/**
 * The step that makes a Marketplace property live, which now happens when its
 * subscription lands rather than when its owner claims it. The failure modes
 * that matter: activating Flow B's placeholder (a hotel with no PMS behind it),
 * running the seven-year import twice because the webhook and the return route
 * both arrived, and a paywall check that says yes to a hotel with no
 * subscription at all.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  activateMarketplaceHotelIfPending,
  hasEntitledSubscription,
  marketplaceTrialDays,
} from "./marketplace-activate";

type Row = Record<string, unknown>;

/** Enough of PostgREST's builder for what the module actually does. */
function fake(seed: Record<string, Row[]> = {}) {
  const tables = new Map<string, Row[]>(
    Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]),
  );
  const t = (n: string) => {
    if (!tables.has(n)) tables.set(n, []);
    return tables.get(n)!;
  };
  const rpcs: { name: string; args: unknown }[] = [];

  function builder(table: string) {
    let mode: "select" | "update" | "insert" | "upsert" = "select";
    const eqs: [string, unknown][] = [];
    let notNull: string | null = null;
    let ins: [string, unknown[]] | null = null;
    let patch: Row | null = null;
    let rows: Row[] = [];

    const match = () =>
      t(table).filter(
        (r) =>
          eqs.every(([c, v]) => r[c] === v) &&
          (!notNull || r[notNull] != null) &&
          (!ins || ins[1].includes(r[ins[0]])),
      );
    const exec = (): Row[] => {
      if (mode === "update") {
        const m = match();
        for (const r of m) Object.assign(r, patch);
        return m;
      }
      if (mode === "insert") {
        const out = rows.map((r) => ({ id: `${table}-${t(table).length + 1}`, ...r }));
        t(table).push(...out);
        return out;
      }
      if (mode === "upsert") {
        t(table).push(...rows);
        return rows;
      }
      return match();
    };

    const api = {
      select: () => api,
      eq: (c: string, v: unknown) => {
        eqs.push([c, v]);
        return api;
      },
      not: (c: string) => {
        notNull = c;
        return api;
      },
      in: (c: string, v: unknown[]) => {
        ins = [c, v];
        return api;
      },
      limit: () => api,
      update: (p: Row) => {
        mode = "update";
        patch = p;
        return api;
      },
      insert: (r: Row | Row[]) => {
        mode = "insert";
        rows = Array.isArray(r) ? r : [r];
        return api;
      },
      upsert: (r: Row | Row[]) => {
        mode = "upsert";
        rows = Array.isArray(r) ? r : [r];
        return api;
      },
      maybeSingle: async () => ({ data: exec()[0] ?? null, error: null }),
      single: async () => ({ data: exec()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => void) =>
        Promise.resolve({ data: exec(), error: null }).then(resolve),
    };
    return api;
  }

  return {
    client: {
      from: builder,
      rpc: async (name: string, args: unknown) => {
        rpcs.push({ name, args });
        return { data: null, error: null };
      },
    } as unknown as SupabaseClient,
    tables,
    rpcs,
  };
}

const HOTEL = "hotel-mkt";
const claimed = () => ({
  hotels: [{ id: HOTEL, is_active: false, setup_pending_at: "2026-09-10T14:08:00Z" }],
  pms_connections: [{ hotel_id: HOTEL, pms_type: "cloudbeds", status: "pending" }],
  pms_marketplace_claims: [
    {
      token: "tok",
      hotel_id: HOTEL,
      pms_type: "cloudbeds",
      property_name: "Sea View Inn",
      claimed_by: "user-1",
      claimed_at: "2026-09-10T14:09:00Z",
    },
  ],
});

describe("activateMarketplaceHotelIfPending", () => {
  it("leaves Flow B's placeholder alone — there is no PMS behind it to import from", async () => {
    const f = fake({
      hotels: [{ id: "hotel-pending", is_active: false, setup_pending_at: "2026-07-01T00:00:00Z" }],
    });
    const r = await activateMarketplaceHotelIfPending(f.client, "hotel-pending");
    expect(r).toEqual({ activated: false, reason: "not_marketplace" });
    expect(f.tables.get("hotels")![0].is_active).toBe(false);
    expect(f.tables.get("import_jobs") ?? []).toHaveLength(0);
  });

  it("makes a claimed Marketplace property live and starts its import", async () => {
    const f = fake(claimed());
    const r = await activateMarketplaceHotelIfPending(f.client, HOTEL, { requestedBy: "user-1" });
    expect(r).toMatchObject({ activated: true, hotelId: HOTEL });

    expect(f.tables.get("hotels")![0]).toMatchObject({ is_active: true, setup_pending_at: null });
    expect(f.tables.get("pms_connections")![0]).toMatchObject({ status: "connected" });

    const jobs = f.tables.get("import_jobs")!;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ hotel_id: HOTEL, pms_type: "cloudbeds", status: "queued", requested_by: "user-1" });
    expect(r).toMatchObject({ importJobId: jobs[0].id });

    expect(f.tables.get("onboarding_states")![0]).toMatchObject({ hotel_id: HOTEL, path: "guided", import_job_id: jobs[0].id });
    expect(f.rpcs.map((x) => x.name)).toContain("platform_log_event");
  });

  it("runs the import exactly once when the webhook and the return route both arrive", async () => {
    const f = fake(claimed());
    const first = await activateMarketplaceHotelIfPending(f.client, HOTEL);
    const second = await activateMarketplaceHotelIfPending(f.client, HOTEL);
    expect(first).toMatchObject({ activated: true });
    expect(second).toEqual({ activated: false, reason: "already_active" });
    expect(f.tables.get("import_jobs")).toHaveLength(1);
  });

  it("falls back to the claim's owner when the caller has no user in hand", async () => {
    const f = fake(claimed());
    await activateMarketplaceHotelIfPending(f.client, HOTEL);
    expect(f.tables.get("import_jobs")![0]).toMatchObject({ requested_by: "user-1" });
  });

  it("accepts the claim being burned right now, whose claimed_at is not on disk yet", async () => {
    const f = fake({
      ...claimed(),
      pms_marketplace_claims: [{ ...claimed().pms_marketplace_claims[0], claimed_at: null, claimed_by: null }],
    });
    const r = await activateMarketplaceHotelIfPending(f.client, HOTEL, {
      claim: { ...claimed().pms_marketplace_claims[0] },
    });
    expect(r).toMatchObject({ activated: true });
  });

  it("reports a property that does not exist rather than inventing one", async () => {
    const f = fake({ pms_marketplace_claims: claimed().pms_marketplace_claims });
    const r = await activateMarketplaceHotelIfPending(f.client, HOTEL);
    expect(r).toEqual({ activated: false, reason: "not_found" });
  });
});

describe("hasEntitledSubscription — the paywall check", () => {
  it("is false for a hotel with no subscription at all, unlike isHotelEntitled", async () => {
    expect(await hasEntitledSubscription(fake().client, HOTEL)).toBe(false);
  });

  it("is false while the subscription is incomplete or dead", async () => {
    for (const status of ["incomplete", "incomplete_expired", "unpaid", "canceled"]) {
      const f = fake({ hotel_subscriptions: [{ hotel_id: HOTEL, status }] });
      expect(await hasEntitledSubscription(f.client, HOTEL)).toBe(false);
    }
  });

  it("is true for trialing, active, and a card mid-retry", async () => {
    for (const status of ["trialing", "active", "past_due"]) {
      const f = fake({ hotel_subscriptions: [{ hotel_id: HOTEL, status }] });
      expect(await hasEntitledSubscription(f.client, HOTEL)).toBe(true);
    }
  });
});

describe("marketplaceTrialDays", () => {
  const original = process.env.MAYA_MARKETPLACE_TRIAL_DAYS;
  afterEach(() => {
    if (original === undefined) delete process.env.MAYA_MARKETPLACE_TRIAL_DAYS;
    else process.env.MAYA_MARKETPLACE_TRIAL_DAYS = original;
  });

  it("is off when unset, and reads the number when set", () => {
    delete process.env.MAYA_MARKETPLACE_TRIAL_DAYS;
    expect(marketplaceTrialDays()).toBe(0);
    process.env.MAYA_MARKETPLACE_TRIAL_DAYS = "7";
    expect(marketplaceTrialDays()).toBe(7);
  });

  it("treats nonsense and negatives as off, and caps a year", () => {
    for (const v of ["abc", "-1", "0", "1.5", ""]) {
      process.env.MAYA_MARKETPLACE_TRIAL_DAYS = v;
      expect(marketplaceTrialDays()).toBe(0);
    }
    process.env.MAYA_MARKETPLACE_TRIAL_DAYS = "9999";
    expect(marketplaceTrialDays()).toBe(365);
  });
});
