/**
 * 99_supabase_migration_account_ready_email_v1.sql, run for real in PGlite: it
 * applies twice, stamps only the rows that existed when it first ran (so no
 * existing customer is ever welcomed, and a second run swallows nobody's
 * email), and the claim the webhook makes hands the row to exactly one caller.
 * RLS and the revoked writes stay as billing_v1 left them. Only runs with
 * MAYA_PGLITE_DIR set (see src/lib/engine/large-property-sql.test.ts).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PGLITE_DIR = process.env.MAYA_PGLITE_DIR;
const MIGRATION = readFileSync(
  resolve(__dirname, "../../../../99_supabase_migration_account_ready_email_v1.sql"),
  "utf8",
);

type Db = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  exec: (sql: string) => Promise<unknown>;
  close: () => Promise<void>;
};

const OLD = "11111111-1111-4111-8111-111111111111";
const BETWEEN = "22222222-2222-4222-8222-222222222222";

/** The claim lib/billing/account-ready.ts makes, as PostgREST runs it. */
const CLAIM = `
  update public.hotel_subscriptions
     set account_ready_emailed_at = now()
   where hotel_id = $1 and stripe_subscription_id = $2 and account_ready_emailed_at is null
  returning hotel_id`;

describe.skipIf(!PGLITE_DIR)("account ready email migration in PGlite", () => {
  let db: Db;

  beforeAll(async () => {
    const mod = await import(
      /* @vite-ignore */ pathToFileURL(`${PGLITE_DIR}/node_modules/@electric-sql/pglite/dist/index.js`).href
    );
    db = new mod.PGlite() as Db;
    // hotel_subscriptions as 99_supabase_migration_billing_v1.sql leaves it,
    // with Supabase's roles and is_hotel_accessible as a switch.
    await db.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin bypassrls;
      grant usage on schema public to anon, authenticated, service_role;
      create or replace function public.is_hotel_accessible(p_hotel_id uuid) returns boolean
        language sql stable as $$ select true $$;
      create table public.hotel_subscriptions (
        hotel_id uuid primary key,
        stripe_customer_id text not null,
        stripe_subscription_id text unique,
        status text not null,
        created_at timestamptz not null default now()
      );
      grant select, insert, update, delete on public.hotel_subscriptions to anon, authenticated, service_role;
      alter table public.hotel_subscriptions enable row level security;
      create policy hotel_subscriptions_read on public.hotel_subscriptions
        for select using (is_hotel_accessible(hotel_id));
      revoke insert, update, delete on public.hotel_subscriptions from anon, authenticated;
      insert into public.hotel_subscriptions (hotel_id, stripe_customer_id, stripe_subscription_id, status)
        values ('${OLD}', 'cus_old', 'sub_old', 'active');
    `);
  });

  afterAll(async () => {
    await db?.close();
  });

  it("stamps only the rows that were there when it first ran", async () => {
    await db.exec(MIGRATION);
    const first = await db.query(
      `select account_ready_emailed_at from public.hotel_subscriptions where hotel_id = '${OLD}'`,
    );
    expect(first.rows[0].account_ready_emailed_at).not.toBeNull();

    // Someone pays between the two runs; the second run must leave them alone.
    await db.query(
      `insert into public.hotel_subscriptions (hotel_id, stripe_customer_id, stripe_subscription_id, status)
       values ('${BETWEEN}', 'cus_new', 'sub_new', 'trialing')`,
    );
    await db.exec(MIGRATION);
    const { rows } = await db.query(
      `select hotel_id, account_ready_emailed_at from public.hotel_subscriptions order by hotel_id`,
    );
    expect(rows[0].account_ready_emailed_at).toEqual(first.rows[0].account_ready_emailed_at);
    expect(rows[1]).toMatchObject({ hotel_id: BETWEEN, account_ready_emailed_at: null });
  });

  it("hands the claim to one caller only", async () => {
    await db.exec("set role service_role;");
    try {
      const won = await db.query(CLAIM, [BETWEEN, "sub_new"]);
      const lost = await db.query(CLAIM, [BETWEEN, "sub_new"]);
      expect(won.rows).toEqual([{ hotel_id: BETWEEN }]);
      expect(lost.rows).toEqual([]);
      // The existing customer was stamped by the migration, so it never wins.
      expect((await db.query(CLAIM, [OLD, "sub_old"])).rows).toEqual([]);
    } finally {
      await db.exec("reset role;");
    }
  });

  it("keeps RLS on and the column out of reach of anyone but the service role", async () => {
    const { rows } = await db.query(
      `select relrowsecurity from pg_class where oid = 'public.hotel_subscriptions'::regclass`,
    );
    expect(rows[0].relrowsecurity).toBe(true);
    await db.exec("set role authenticated;");
    try {
      await expect(
        db.query(`update public.hotel_subscriptions set account_ready_emailed_at = null`),
      ).rejects.toThrow(/permission denied/);
      // Members can still read their own row, the column included.
      expect((await db.query(`select account_ready_emailed_at from public.hotel_subscriptions`)).rows).toHaveLength(2);
    } finally {
      await db.exec("reset role;");
    }
  });
});
