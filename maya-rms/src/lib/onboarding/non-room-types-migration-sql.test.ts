/**
 * 99_supabase_migration_non_room_types_v1.sql run for real in PGlite, twice,
 * on top of every migration before it: which floors it puts back to the
 * default (the hotel-wide answer on a type unticked as a room), which it
 * leaves alone (a room, an unanswered type, a type with its own floor, a
 * hotel with no answer, a floor accepted from a suggestion card), the audit
 * line it leaves, the re-price it asks for, and that platform_pilot_health()
 * no longer counts a night held as guardrail:not_a_room as waiting to be
 * sent. Only runs with MAYA_PGLITE_DIR set (see pricing-cadence-sql.test.ts).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PGLITE_DIR = process.env.MAYA_PGLITE_DIR;
const ROOT = resolve(__dirname, "../../../..");
const MIGRATION = "99_supabase_migration_non_room_types_v1.sql";

/** The order production ran the migrations in, read off the cadence test's list. */
const MIGRATION_ORDER: string[] = (() => {
  const src = readFileSync(resolve(__dirname, "../engine/pricing-cadence-sql.test.ts"), "utf8");
  const list = src.slice(src.indexOf("MIGRATION_ORDER = ["), src.indexOf("];", src.indexOf("MIGRATION_ORDER = [")));
  return [...list.matchAll(/"(99_supabase_migration_[^"]+\.sql)"/g)].map((m) => m[1]);
})();

type Db = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  exec: (sql: string, options?: { onNotice?: (notice: { message?: string }) => void }) => Promise<unknown>;
  close: () => Promise<void>;
};

const PLATFORM = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create role supabase_admin nologin;
grant usage on schema public to anon, authenticated, service_role;
create schema auth;
create table auth.users (
  id uuid primary key, email text, raw_user_meta_data jsonb, raw_app_meta_data jsonb,
  created_at timestamptz default now(), last_sign_in_at timestamptz, email_confirmed_at timestamptz,
  confirmed_at timestamptz, phone text, updated_at timestamptz, banned_until timestamptz, deleted_at timestamptz
);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claim.role', true), '')
$$;
create or replace function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
create schema vault;
`;

function fileSql(name: string): string {
  let sql = readFileSync(resolve(ROOT, name), "utf8");
  sql = sql.replace(/create extension if not exists supabase_vault[^;]*;/gi, "");
  if (name === "99_supabase_migration_rate_push_v1.sql") sql = `drop table if exists public.rate_updates cascade;\n${sql}`;
  return sql;
}

const H = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const ANSWERED = H(1);
const NO_ANSWER = H(2);
const LIVE = H(3);
const RT = (hotel: number, n: number) => `10000000-0000-4000-8000-0000000000${hotel}${n}`;
const KING = RT(1, 1);
const PARKING = RT(1, 2);
const COURT = RT(1, 3);
const BOARDROOM = RT(1, 4);
const STORAGE = RT(1, 5);
const CLOSED_WING = RT(1, 6);
const OTHER_PARKING = RT(2, 1);
const LIVE_KING = RT(3, 1);
const LIVE_PARKING = RT(3, 2);
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const today = new Date().toISOString().slice(0, 10);
const night = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe("the migration file", () => {
  it("is on the list the SQL tests build production's schema from, after the files it builds on", () => {
    expect(MIGRATION_ORDER).toContain(MIGRATION);
    expect(MIGRATION_ORDER.indexOf(MIGRATION)).toBeGreaterThan(MIGRATION_ORDER.indexOf("99_supabase_migration_pilot_health_v2.sql"));
    expect(MIGRATION_ORDER.indexOf(MIGRATION)).toBeGreaterThan(
      MIGRATION_ORDER.indexOf("99_supabase_migration_room_type_counts_as_room_v1.sql"),
    );
  });

  it("is one transaction, creates no table and changes no policy", () => {
    const sql = readFileSync(resolve(ROOT, MIGRATION), "utf8").replace(/--.*$/gm, "");
    expect(sql.match(/\bbegin;/g)).toHaveLength(1);
    expect(sql.match(/\bcommit;/g)).toHaveLength(1);
    expect(sql).not.toMatch(/create table|alter table|create policy|drop policy/i);
  });
});

describe.skipIf(!PGLITE_DIR)("the non-room types migration in PGlite", () => {
  let db: Db;
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  const asService = async <T>(fn: () => Promise<T>): Promise<T> => {
    await db.exec(`select set_config('request.jwt.claim.role', 'service_role', false)`);
    try {
      return await fn();
    } finally {
      await db.exec(`select set_config('request.jwt.claim.role', '', false)`);
    }
  };
  const floors = async () =>
    Object.fromEntries(
      (await q(`select id, floor_price::text as f from public.room_types order by id`)).map((r) => [String(r.id), String(r.f)]),
    );
  const cleared = async () =>
    await q(
      `select entity_id, hotel_id, detail from public.platform_audit_events where event_type = 'room_type.floor_cleared' order by created_at, entity_id`,
    );
  const health = async (name: string) =>
    (await asService(() => q(`select name, unsent_count, unsent_since from public.platform_pilot_health($1)`, [false]))).find(
      (r) => r.name === name,
    );

  beforeAll(async () => {
    const dist = `${PGLITE_DIR}/node_modules/@electric-sql/pglite/dist`;
    const mod = await import(/* @vite-ignore */ pathToFileURL(`${dist}/index.js`).href);
    const { pgcrypto } = await import(/* @vite-ignore */ pathToFileURL(`${dist}/contrib/pgcrypto.js`).href);
    const { citext } = await import(/* @vite-ignore */ pathToFileURL(`${dist}/contrib/citext.js`).href);
    db = new mod.PGlite({ extensions: { pgcrypto, citext } }) as Db;
    await db.exec(PLATFORM);
    for (const name of [
      "01_supabase_base_schema.sql",
      "02_supabase_schema.sql",
      ...MIGRATION_ORDER.slice(0, MIGRATION_ORDER.indexOf(MIGRATION)),
      // The cadence test's own file, which its list leaves out: the room_types trigger and hotel_pricing_state are made there.
      "99_supabase_migration_pricing_cadence_v1.sql",
    ]) {
      try {
        await db.exec(fileSql(name));
      } catch (e) {
        throw new Error(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // What the old projection left behind: the $110 answer on every active
    // type, rooms or not, at a hotel that answered; and a hotel that never did.
    await db.exec(`
      select set_config('request.jwt.claim.role', 'service_role', false);
      insert into auth.users (id, email) values ('${ADMIN}', 'jake@example.com');
      insert into public.app_roles (user_id, role) values ('${ADMIN}', 'platform_admin');
      insert into public.hotels (id, name, timezone) values
        ('${ANSWERED}', 'Answered Inn', 'America/Denver'),
        ('${NO_ANSWER}', 'Quiet Inn', 'UTC'),
        ('${LIVE}', 'Live Inn', 'UTC');
      insert into public.hotel_settings (hotel_id, simulation_mode, strategy_floor) values
        ('${ANSWERED}', true, 110), ('${NO_ANSWER}', true, null), ('${LIVE}', false, 110)
        on conflict (hotel_id) do update set simulation_mode = excluded.simulation_mode, strategy_floor = excluded.strategy_floor;
      update public.hotel_settings set live_since = now() - interval '7 days' where hotel_id = '${LIVE}';
      insert into public.pms_connections (hotel_id, pms_type, status, last_sync_at) values
        ('${LIVE}', 'cloudbeds', 'connected', now() - interval '3 minutes');
      insert into public.room_types (id, hotel_id, external_room_type_id, name, total_rooms, is_active, counts_as_room, floor_price, ceiling_price) values
        ('${KING}', '${ANSWERED}', 'K', 'King', 10, true, true, 110, 400),
        ('${PARKING}', '${ANSWERED}', 'P', 'Parking', 20, true, false, 110, 400),
        ('${COURT}', '${ANSWERED}', 'C', 'Pickleball Court', 2, true, false, 40, 400),
        ('${BOARDROOM}', '${ANSWERED}', 'B', 'Boardroom', 1, true, false, 110, 400),
        ('${STORAGE}', '${ANSWERED}', 'S', 'Storage', 3, true, null, 110, 400),
        ('${CLOSED_WING}', '${ANSWERED}', 'W', 'Closed wing parking', 3, false, false, 110, 400),
        ('${OTHER_PARKING}', '${NO_ANSWER}', 'P', 'Parking', 5, true, false, 110, 400),
        ('${LIVE_KING}', '${LIVE}', 'K', 'King', 8, true, true, 110, 400),
        ('${LIVE_PARKING}', '${LIVE}', 'P', 'Parking', 6, true, false, 110, 400);
      -- The owner accepted a floor card for the Boardroom, at the answer's amount: their own choice.
      insert into public.onboarding_findings (hotel_id, kind, status, payload, resolved_by, resolved_at) values
        ('${ANSWERED}', 'guardrail_suggestion', 'confirmed',
         jsonb_build_object('room_type_id', '${BOARDROOM}', 'field', 'floor_price', 'suggested', 110), '${ADMIN}', now()),
        -- A dismissed card and a ceiling card settle nothing about the floor.
        ('${ANSWERED}', 'guardrail_suggestion', 'dismissed',
         jsonb_build_object('room_type_id', '${PARKING}', 'field', 'floor_price', 'suggested', 110), '${ADMIN}', now()),
        ('${ANSWERED}', 'guardrail_suggestion', 'confirmed',
         jsonb_build_object('room_type_id', '${PARKING}', 'field', 'ceiling_price', 'suggested', 400), '${ADMIN}', now());
      -- Live Inn: a published parking price the send step holds, and one the floor holds.
      insert into public.published_price (hotel_id, stay_date, room_type_id, price, base_price, computed_at) values
        ('${LIVE}', '${night(5)}', '${LIVE_PARKING}', 110, 110, now() - interval '3 hours'),
        ('${LIVE}', '${night(6)}', '${LIVE_PARKING}', 110, 110, now() - interval '3 hours'),
        ('${LIVE}', '${night(5)}', '${LIVE_KING}', 210, 210, now() - interval '3 hours');
      insert into public.rate_updates (hotel_id, pms_type, room_type_id, stay_date, price, status, attempts, error, pushed_at) values
        ('${LIVE}', 'cloudbeds', '${LIVE_PARKING}', '${night(5)}', 110, 'skipped', 0, 'guardrail:not_a_room', now() - interval '2 hours'),
        ('${LIVE}', 'cloudbeds', '${LIVE_PARKING}', '${night(6)}', 110, 'skipped', 0, 'guardrail:below_floor', now() - interval '2 hours'),
        ('${LIVE}', 'cloudbeds', '${LIVE_KING}', '${night(5)}', 210, 'sent', 1, null, now() - interval '2 hours');
      delete from public.pricing_dirty_nights;
      delete from public.hotel_pricing_state;
      select set_config('request.jwt.claim.role', '', false);
    `);
  }, 180_000);

  afterAll(async () => {
    await db?.close();
  });

  it("puts the answer's floor back to the default on types unticked as rooms, and on nothing else", async () => {
    const before = await floors();
    expect(before[PARKING]).toBe("110.00");

    await db.exec(fileSql(MIGRATION));

    const after = await floors();
    // Cleared: the answer on a type unticked as a room, switched on or off.
    expect(after[PARKING]).toBe("1.00");
    expect(after[LIVE_PARKING]).toBe("1.00");
    expect(after[CLOSED_WING]).toBe("1.00");
    // Kept: a room; a type nobody has answered for; a non-room with a floor of
    // its own; a floor the owner accepted from a card; a hotel with no answer.
    expect(after[KING]).toBe("110.00");
    expect(after[LIVE_KING]).toBe("110.00");
    expect(after[STORAGE]).toBe("110.00");
    expect(after[COURT]).toBe("40.00");
    expect(after[BOARDROOM]).toBe("110.00");
    expect(after[OTHER_PARKING]).toBe("110.00");
    // Ceilings are not touched.
    expect(await q(`select count(*)::int as n from public.room_types where ceiling_price <> 400`)).toEqual([{ n: 0 }]);
  });

  it("says what it put back, once per room type, with the value it had", async () => {
    const rows = await cleared();
    expect(rows.map((r) => String(r.entity_id)).sort()).toEqual([PARKING, CLOSED_WING, LIVE_PARKING].sort());
    const parking = rows.find((r) => r.entity_id === PARKING)!;
    expect(parking.hotel_id).toBe(ANSWERED);
    expect(parking.detail).toMatchObject({
      room_type_id: PARKING,
      name: "Parking",
      before: 110,
      after: 1,
      strategy_floor: 110,
      via: MIGRATION,
    });
  });

  it("asks for the hotels it touched to be priced again, through the room_types trigger", async () => {
    const marked = (await q(`select hotel_id from public.hotel_pricing_state where full_reprice_seq > 0 order by hotel_id`)).map((r) =>
      String(r.hotel_id),
    );
    expect(marked).toEqual([ANSWERED, LIVE].sort());
  });

  it("changes nothing more on a second run", async () => {
    const before = await floors();
    const events = (await cleared()).length;
    await db.exec(fileSql(MIGRATION));
    expect(await floors()).toEqual(before);
    expect((await cleared()).length).toBe(events);
  });

  it("pilot health no longer counts a night held as not a room as waiting to be sent, and still counts the rest", async () => {
    const live = await health("Live Inn");
    // The parking night held for the floor still waits; the one held as not a room does not.
    expect(live).toMatchObject({ unsent_count: 1 });
    expect(live?.unsent_since).not.toBeNull();
    // With the not-a-room hold gone from the ledger the night counts again.
    await asService(() =>
      db.exec(`delete from public.rate_updates where room_type_id = '${LIVE_PARKING}' and stay_date = '${night(5)}'`),
    );
    expect(await health("Live Inn")).toMatchObject({ unsent_count: 2 });
  });

  it("keeps the function's check and grants", async () => {
    await expect(q(`select * from public.platform_pilot_health(false)`)).rejects.toThrow(/Not authorized/);
    const grants = (
      await q(
        `select has_function_privilege('anon', 'public.platform_pilot_health(boolean)', 'execute') as anon,
                has_function_privilege('authenticated', 'public.platform_pilot_health(boolean)', 'execute') as authenticated,
                has_function_privilege('service_role', 'public.platform_pilot_health(boolean)', 'execute') as service_role`,
      )
    )[0];
    expect(grants).toEqual({ anon: false, authenticated: true, service_role: true });
  });

  it("names each type unticked as a room that MAYA has already sent a rate to, for a person to set back by hand", async () => {
    // Live Inn's parking bay got the $110 room floor sent to it last week for
    // two nights ahead, and a third night's send is still in the past. The
    // hold keeps every further send back, so that $110 stays in Cloudbeds
    // until somebody changes it there: the file has to say so.
    await asService(() =>
      db.exec(`
        insert into public.rate_updates (hotel_id, pms_type, room_type_id, stay_date, price, status, attempts, error, pushed_at) values
          ('${LIVE}', 'cloudbeds', '${LIVE_PARKING}', '${night(7)}', 110, 'sent', 1, null, now() - interval '7 days'),
          ('${LIVE}', 'cloudbeds', '${LIVE_PARKING}', '${night(8)}', 105, 'sent', 1, null, now() - interval '6 days'),
          ('${LIVE}', 'cloudbeds', '${LIVE_PARKING}', '${night(-3)}', 110, 'sent', 1, null, now() - interval '9 days'),
          -- A held night MAYA never sent to says nothing about what is in Cloudbeds.
          ('${LIVE}', 'cloudbeds', '${LIVE_PARKING}', '${night(9)}', 110, 'skipped', 0, 'guardrail:not_a_room', now() - interval '1 hour')
        on conflict (hotel_id, room_type_id, stay_date) do update set price = excluded.price, status = excluded.status, attempts = excluded.attempts, error = excluded.error, pushed_at = excluded.pushed_at;
      `),
    );
    const notices: string[] = [];
    await db.exec(fileSql(MIGRATION), { onNotice: (n) => notices.push(String(n.message ?? "")) });
    const named = notices.filter((n) => n.includes("MAYA has sent a rate to"));
    expect(named).toHaveLength(1);
    // The type, the hotel, the nights from today on, and the rate sent last.
    expect(named[0]).toContain('"Parking" (Live Inn, not a room, cloudbeds)');
    expect(named[0]).toContain(`2 night(s) from ${night(7)} to ${night(8)}`);
    expect(named[0]).toContain("last 105.00");
    expect(named[0]).toContain("set it back by hand");
    expect(notices.some((n) => n.includes("1 room type(s) unticked as rooms hold a rate MAYA sent"))).toBe(true);
    // Rooms, and types never sent to, are not named.
    expect(notices.some((n) => n.includes('"King"'))).toBe(false);
    expect(notices.some((n) => n.includes("Answered Inn"))).toBe(false);
    // Reads only: a third run changed nothing.
    expect((await cleared()).length).toBe(3);
  });
});
