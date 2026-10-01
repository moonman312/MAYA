/**
 * Regression tests for the Supabase-mode paths of createRule/updateRule.
 *
 * These pin two real bugs an adversarial review found:
 *   1. createRule could insert a live, active pricing_rules row and THEN
 *      discover the legacy conditions map had nothing parseable — leaving
 *      an active rule with zero conditions, which the engine treats as
 *      "always matches every stay date."
 *   2. updateRule validated the new condition AFTER already bumping the
 *      rule's version, retiring its pickup events, and writing its other
 *      field changes — so a rejected edit still landed everything except
 *      the condition, while reporting failure to the caller.
 *
 * A minimal in-memory fake stands in for Supabase: enough of `.from()`
 * chaining to exercise both functions' real control flow.
 */
import { describe, expect, it } from "vitest";
import { ruleWaitDays } from "./engine/pickup";
import { formatRuleConditionsDisplay } from "./rule-form";
import { createRule, listEngineRules, listRules, updateRule, type CreateRuleInput } from "./rules-store";

type Row = Record<string, unknown>;

function fakeSupabase(seed: Record<string, Row[]> = {}) {
  const tables = new Map<string, Row[]>(Object.entries(seed).map(([k, v]) => [k, [...v]]));
  let nextId = 1;
  const tableOf = (name: string) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  };

  // Rows whose insert should fail — simulates a DB constraint rejection on
  // specifically the NEW data, not a blanket table outage (so a compensating
  // re-insert of the untouched OLD row is expected to succeed).
  const failInsertWhen = new Map<string, (row: Row) => boolean>();
  /** Ids row security won't let this caller update (staff, viewers): the update touches nothing. */
  const readOnly = new Set<string>();
  /** Every column list a read asked for, by table. */
  const selects: { table: string; columns: string }[] = [];

  function matches(row: Row, filters: [string, unknown][]): boolean {
    return filters.every(([col, val]) => row[col] === val);
  }

  function builder(table: string) {
    const filters: [string, unknown][] = [];
    let pendingInsert: Row[] | null = null;
    let pendingUpdate: Row | null = null;
    let mode: "insert" | "update" | "delete" | "select" = "select";

    const api = {
      select(columns?: string) {
        if (mode === "select" && columns) selects.push({ table, columns });
        return api;
      },
      eq(col: string, val: unknown) {
        filters.push([col, val]);
        return api;
      },
      is(col: string, val: unknown) {
        filters.push([col, val]);
        return api;
      },
      order() {
        return api;
      },
      insert(payload: Row | Row[]) {
        pendingInsert = Array.isArray(payload) ? payload : [payload];
        mode = "insert";
        return api;
      },
      update(patch: Row) {
        pendingUpdate = patch;
        mode = "update";
        return api;
      },
      delete() {
        mode = "delete";
        return api;
      },
      async maybeSingle() {
        const rows = tableOf(table).filter((r) => matches(r, filters));
        return { data: rows[0] ?? null, error: null };
      },
      async single() {
        const result = await run();
        const rows = Array.isArray(result.data) ? result.data : result.data ? [result.data] : [];
        return { data: rows[0] ?? null, error: result.error };
      },
      then(resolve: (v: { data: unknown; error: { message: string } | null }) => void) {
        return run().then(resolve);
      },
    };

    async function run() {
      if (mode === "insert" && pendingInsert) {
        const shouldFail = failInsertWhen.get(table);
        if (shouldFail && pendingInsert.some(shouldFail)) {
          return { data: null, error: { message: `insert into ${table} rejected` } };
        }
        const inserted = pendingInsert.map((r) => ({ id: r.id ?? String(nextId++), ...r }));
        tableOf(table).push(...inserted);
        return { data: inserted, error: null };
      }
      if (mode === "update" && pendingUpdate) {
        const updated: Row[] = [];
        for (const r of tableOf(table)) {
          if (matches(r, filters) && !readOnly.has(String(r.id))) {
            Object.assign(r, pendingUpdate);
            updated.push(r);
          }
        }
        return { data: updated, error: null };
      }
      if (mode === "delete") {
        const rows = tableOf(table);
        const kept = rows.filter((r) => !matches(r, filters));
        tables.set(table, kept);
        return { data: null, error: null };
      }
      const rows = tableOf(table).filter((r) => matches(r, filters));
      return { data: rows, error: null };
    }

    return api;
  }

  const client = { from: (t: string) => builder(t) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, tables, failInsertWhen, selects, readOnly };
}

const HOTEL = "hotel-1";

function baseCreateInput(overrides: Partial<CreateRuleInput> = {}): CreateRuleInput {
  return {
    rule_name: "Test rule",
    conditions: {},
    action: { adjust_rate_percent: 10 },
    room_types: [],
    ...overrides,
  };
}

describe("createRule (Supabase mode): legacy conditions validated before insert", () => {
  it("throws and inserts nothing when the legacy map has no parseable family", async () => {
    const { client, tables } = fakeSupabase();
    await expect(
      createRule(
        baseCreateInput({ conditions: { occupancy_percentage: "80" } }), // no operator prefix
        client,
        HOTEL,
      ),
    ).rejects.toThrow(/at least one valid condition/i);
    expect(tables.get("pricing_rules") ?? []).toHaveLength(0);
  });

  it("throws and inserts nothing when the only operator is illegal for the DB (>=, <=, =, !=)", async () => {
    const { client, tables } = fakeSupabase();
    await expect(
      createRule(baseCreateInput({ conditions: { occupancy_percentage: ">=80" } }), client, HOTEL),
    ).rejects.toThrow(/at least one valid condition/i);
    expect(tables.get("pricing_rules") ?? []).toHaveLength(0);
  });

  it("succeeds and persists a well-formed legacy condition", async () => {
    const { client, tables } = fakeSupabase();
    await createRule(baseCreateInput({ conditions: { occupancy_percentage: ">80" } }), client, HOTEL);
    expect(tables.get("pricing_rules")).toHaveLength(1);
    const cond = tables.get("rule_condition")?.[0];
    expect(cond).toMatchObject({ occupancy_operator: "gt", occupancy_threshold: 0.8 });
  });
});

describe("updateRule: validates before mutating, repairs a failed condition write", () => {
  function seedRule(): Record<string, Row[]> {
    return {
      pricing_rules: [{ id: "r1", version: 1, is_active: true, is_pickup_rule: false }],
      rule_condition: [{ rule_id: "r1", occupancy_operator: "gt", occupancy_threshold: 0.5 }],
      pickup_event: [{ id: "pe1", rule_id: "r1", retired_at: null }],
    };
  }

  it("rejects an empty new condition WITHOUT bumping version, retiring pickup events, or touching the row", async () => {
    const { client, tables } = fakeSupabase(seedRule());
    const ok = await updateRule("r1", { condition: {} }, client);
    expect(ok).toBe(false);
    expect(tables.get("pricing_rules")?.[0]).toMatchObject({ version: 1 });
    expect(tables.get("pickup_event")?.[0]).toMatchObject({ retired_at: null });
    expect(tables.get("rule_condition")?.[0]).toMatchObject({ occupancy_threshold: 0.5 });
  });

  it("restores the previous condition row when the new insert fails, instead of leaving zero conditions", async () => {
    const { client, tables, failInsertWhen } = fakeSupabase(seedRule());
    // Only the NEW data is rejected (e.g. a constraint on 0.9) — the old
    // row's own values must still be safe to re-insert.
    failInsertWhen.set("rule_condition", (row) => row.occupancy_threshold === 0.9);
    const ok = await updateRule(
      "r1",
      { condition: { occupancy_operator: "gt", occupancy_threshold: 0.9 } },
      client,
    );
    expect(ok).toBe(false);
    // The old row must still be there — not wiped by the failed edit.
    expect(tables.get("rule_condition")).toHaveLength(1);
    expect(tables.get("rule_condition")?.[0]).toMatchObject({ occupancy_threshold: 0.5 });
  });

  it("succeeds on a valid edit: bumps version, replaces the condition, leaves the fires to the engine", async () => {
    const { client, tables } = fakeSupabase(seedRule());
    const ok = await updateRule(
      "r1",
      { condition: { occupancy_operator: "lt", occupancy_threshold: 0.3 } },
      client,
    );
    expect(ok).toBe(true);
    expect(tables.get("pricing_rules")?.[0]).toMatchObject({ version: 2 });
    // Nothing on the price moves at the save: the engine takes a fire of an
    // older version off on its next run, and only while the rule is on
    // (firesToReset), so an edit to a rule that is off moves no price.
    expect(tables.get("pickup_event")?.[0]).toMatchObject({ retired_at: null });
    expect(tables.get("rule_condition")).toHaveLength(1);
    expect(tables.get("rule_condition")?.[0]).toMatchObject({ occupancy_operator: "lt", occupancy_threshold: 0.3 });
  });
});

describe("listRules: occupancy percentage display does not show float noise", () => {
  // numeric(8,4) 0.57 * 100 without rounding is 56.99999999999999 in
  // floating point — every one of these is a perfectly ordinary threshold.
  it.each([7, 14, 28, 29, 55, 56, 57, 58, 75])("round-trips %d%% exactly, no trailing float noise", async (pct) => {
    const { client } = fakeSupabase({
      pricing_rules: [
        {
          id: "r1",
          hotel_id: "h1",
          name: "Test",
          is_active: true,
          version: 1,
          action_type: "percent",
          action_direction: "increase",
          action_value: 10,
          is_pickup_rule: false,
          rule_condition: { occupancy_operator: "gt", occupancy_threshold: pct / 100 },
        },
      ],
    });
    const rules = await listRules(client, "h1");
    expect(rules[0].conditions.occupancy_percentage).toBe(`>${pct}`);
  });
});

describe("listRules: a rule that covers only some nights says which", () => {
  const rule = (start: string | null, end: string | null) => ({
    id: "r1",
    hotel_id: "h1",
    name: "Autumn",
    is_active: true,
    version: 1,
    start_date: start,
    end_date: end,
    action_type: "percent",
    action_direction: "increase",
    action_value: 6,
    is_pickup_rule: false,
    rule_condition: { occupancy_operator: "gt", occupancy_threshold: 0.25 },
  });
  it("names the nights after its conditions, and says nothing for every night", async () => {
    const shown = async (start: string | null, end: string | null) =>
      formatRuleConditionsDisplay((await listRules(fakeSupabase({ pricing_rules: [rule(start, end)] }).client, "h1"))[0].conditions);
    expect(await shown("2026-10-15", "2026-11-30")).toBe("Occupancy above 25% · Nights Oct 15, 2026 to Nov 30, 2026");
    expect(await shown("2026-10-15", null)).toBe("Occupancy above 25% · Nights from Oct 15, 2026");
    expect(await shown(null, "2026-11-30")).toBe("Occupancy above 25% · Nights until Nov 30, 2026");
    expect(await shown(null, null)).toBe("Occupancy above 25%");
  });
});

describe("listRules: a booking speed rule's card says how long it waits", () => {
  const card = async (cooldown: number | null, pickup?: { operator: string; windowDays: number }) => {
    const { client } = fakeSupabase({
      pricing_rules: [
        {
          id: "r1",
          hotel_id: "h1",
          name: "Hot-week surge",
          is_active: true,
          version: 1,
          action_type: "percent",
          action_direction: "increase",
          action_value: 25,
          is_pickup_rule: true,
          rule_condition: {
            booking_speed_operator: "at_least",
            booking_speed_level: "much_faster",
            booking_speed_window_days: 7,
            booking_speed_cooldown_days: cooldown,
            ...(pickup
              ? { pickup_operator: pickup.operator, pickup_threshold: 5, pickup_window_days: pickup.windowDays }
              : {}),
          },
        },
      ],
    });
    return (await listRules(client, "h1"))[0].conditions.booking_speed;
  };

  it("names the wait, because the rule acts again once it is over", async () => {
    expect(await card(2)).toBe("at least Much Faster Than Normal (past week), then waits 2 days");
    expect(await card(14)).toBe("at least Much Faster Than Normal (past week), then waits 2 weeks");
  });

  it("reads a rule saved without one as the week the engine gives it", async () => {
    expect(await card(null)).toBe("at least Much Faster Than Normal (past week), then waits 1 week");
  });

  it("names the longer wait when the rule also counts pickup, because that is the one the engine keeps", async () => {
    // ruleWaitDays takes the longer of the stored wait and the pickup window.
    expect(await card(1, { operator: "gt", windowDays: 7 })).toBe(
      "at least Much Faster Than Normal (past week), then waits 1 week",
    );
    // And the stored wait still wins when it is the longer one.
    expect(await card(14, { operator: "gt", windowDays: 7 })).toBe(
      "at least Much Faster Than Normal (past week), then waits 2 weeks",
    );
  });
});

describe("a pickup count rule's wait round-trips through the store", () => {
  const pickup = { pickup_operator: "gt", pickup_threshold: 5, pickup_window_days: 7, pickup_metric: "room_nights" } as const;
  /** The rule as PostgREST hands it back: its condition embedded. */
  const readBack = (tables: Map<string, Row[]>) => {
    const rule = { ...tables.get("pricing_rules")![0], rule_condition: tables.get("rule_condition")![0] };
    return fakeSupabase({ pricing_rules: [rule] });
  };

  it("writes the wait chosen, and the engine reads it back and waits it", async () => {
    const { client, tables } = fakeSupabase();
    await createRule(baseCreateInput({ condition: { ...pickup, pickup_cooldown_days: 2 } }), client, HOTEL);
    expect(tables.get("rule_condition")![0]).toMatchObject({ ...pickup, pickup_cooldown_days: 2 });
    expect(tables.get("pricing_rules")![0]).toMatchObject({ is_pickup_rule: true });
    const reader = readBack(tables);
    const [rule] = await listEngineRules(reader.client, HOTEL);
    expect(rule.condition.pickup_cooldown_days).toBe(2);
    expect(ruleWaitDays(rule)).toBe(2);
    // The read asks for the column: the fake hands back whole rows, PostgREST doesn't.
    expect(reader.selects.find((s) => s.table === "pricing_rules")?.columns).toMatch(/rule_condition \([^)]*pickup_cooldown_days/);
  });

  it("left on the lookback window, writes no wait, and reads back as the window", async () => {
    const { client, tables } = fakeSupabase();
    await createRule(baseCreateInput({ condition: { ...pickup, pickup_cooldown_days: null } }), client, HOTEL);
    expect(tables.get("rule_condition")![0]).not.toHaveProperty("pickup_cooldown_days");
    const [rule] = await listEngineRules(readBack(tables).client, HOTEL);
    expect(rule.condition.pickup_cooldown_days).toBeNull();
    expect(ruleWaitDays(rule)).toBe(7);
  });

  it("changing only the wait is an edit: the version moves on, and the engine judges the fires", async () => {
    const { client, tables } = fakeSupabase({
      pricing_rules: [{ id: "r1", version: 1, is_active: true, is_pickup_rule: true }],
      rule_condition: [{ rule_id: "r1", ...pickup }],
      pickup_event: [{ id: "pe1", rule_id: "r1", retired_at: null }],
    });
    expect(await updateRule("r1", { condition: { ...pickup, pickup_cooldown_days: 2 } }, client)).toBe(true);
    expect(tables.get("pricing_rules")![0]).toMatchObject({ version: 2, is_pickup_rule: true });
    expect(tables.get("pickup_event")![0]).toMatchObject({ retired_at: null });
    expect(tables.get("rule_condition")).toHaveLength(1);
    expect(tables.get("rule_condition")![0]).toMatchObject({ rule_id: "r1", ...pickup, pickup_cooldown_days: 2 });

    // And back to the window.
    expect(await updateRule("r1", { condition: { ...pickup, pickup_cooldown_days: null } }, client)).toBe(true);
    expect(tables.get("pricing_rules")![0]).toMatchObject({ version: 3 });
    expect(tables.get("rule_condition")).toHaveLength(1);
    expect(tables.get("rule_condition")![0]).toMatchObject({ rule_id: "r1", ...pickup });
    expect(tables.get("rule_condition")![0]).not.toHaveProperty("pickup_cooldown_days");
  });

  it("the rules table says a pickup rule's window and the wait it keeps, chosen or not", async () => {
    const table = async (condition: Record<string, unknown>) => {
      const { client } = fakeSupabase({
        pricing_rules: [
          {
            id: "r1",
            hotel_id: "h1",
            name: "Pickup",
            is_active: true,
            version: 1,
            action_type: "percent",
            action_direction: "increase",
            action_value: 10,
            is_pickup_rule: true,
            rule_condition: condition,
          },
        ],
      });
      return formatRuleConditionsDisplay((await listRules(client, "h1"))[0].conditions);
    };
    expect(await table({ ...pickup, pickup_cooldown_days: 2 })).toBe("Pickup above 5 bookings (past week), then waits 2 days");
    // None chosen: it waits its window (ruleWaitDays).
    expect(await table({ ...pickup, pickup_cooldown_days: null })).toBe("Pickup above 5 bookings (past week), then waits 1 week");
    expect(await table({ ...pickup, pickup_window_days: 3, pickup_cooldown_days: null })).toBe(
      "Pickup above 5 bookings (past 3 days), then waits 3 days",
    );
    expect(await table({ ...pickup, pickup_operator: "lt", pickup_window_days: 1, pickup_cooldown_days: 14 })).toBe(
      "Pickup below 5 bookings (past day), then waits 2 weeks",
    );
    // A rule on low pickup never adjusts a night again before its whole
    // window has passed (pickupJudgesShortStretch), so a shorter wait reads
    // as its window.
    expect(await table({ ...pickup, pickup_operator: "lt", pickup_cooldown_days: 1 })).toBe(
      "Pickup below 5 bookings (past week), then waits 1 week",
    );
    // With booking speed too, the wait is said once, the longer of the two.
    expect(
      await table({
        ...pickup,
        pickup_cooldown_days: 2,
        booking_speed_operator: "at_least",
        booking_speed_level: "faster",
        booking_speed_window_days: 7,
        booking_speed_cooldown_days: 3,
      }),
    ).toBe("Pickup above 5 bookings (past week) · booking speed at least Faster Than Normal (past week), then waits 3 days");
  });

  it("the card names the pickup wait chosen when it is longer than the booking speed one", async () => {
    const { client } = fakeSupabase({
      pricing_rules: [
        {
          id: "r1",
          hotel_id: "h1",
          name: "Both",
          is_active: true,
          version: 1,
          action_type: "percent",
          action_direction: "increase",
          action_value: 10,
          is_pickup_rule: true,
          rule_condition: {
            ...pickup,
            pickup_cooldown_days: 14,
            booking_speed_operator: "at_least",
            booking_speed_level: "faster",
            booking_speed_window_days: 7,
            booking_speed_cooldown_days: 3,
          },
        },
      ],
    });
    expect((await listRules(client, "h1"))[0].conditions.booking_speed).toBe(
      "at least Faster Than Normal (past week), then waits 2 weeks",
    );
  });
});

describe("the undo box round-trips through the store", () => {
  const occupancy = { occupancy_operator: "gt", occupancy_threshold: 0.7 } as const;
  const readBack = (tables: Map<string, Row[]>) => {
    const rule = { ...tables.get("pricing_rules")![0], rule_condition: tables.get("rule_condition")![0] };
    return fakeSupabase({ pricing_rules: [rule] });
  };

  it("a new rule is written ticked unless the owner unticked it, and reads back the same way to the table and the engine", async () => {
    for (const [given, stored] of [
      [undefined, true],
      [true, true],
      [false, false],
    ] as const) {
      const { client, tables } = fakeSupabase();
      await createRule(baseCreateInput({ condition: occupancy, undo_on_cancellation: given }), client, HOTEL);
      expect(tables.get("pricing_rules")![0]).toMatchObject({ undo_on_cancellation: stored });
      const reader = readBack(tables);
      expect((await listRules(reader.client, HOTEL))[0].undo_on_cancellation).toBe(stored);
      expect((await listEngineRules(reader.client, HOTEL))[0].undo_on_cancellation).toBe(stored);
      // The reads ask for the column.
      expect(reader.selects.find((s) => s.table === "pricing_rules")?.columns).toMatch(/undo_on_cancellation/);
    }
  });

  it("a rule saved before the box existed reads as ticked", async () => {
    const { client } = fakeSupabase({ pricing_rules: [{ id: "r1", hotel_id: HOTEL, name: "Old", is_active: true, action_type: "percent", action_direction: "increase", action_value: 10, rule_condition: occupancy }] });
    expect((await listRules(client, HOTEL))[0].undo_on_cancellation).toBe(true);
    expect((await listEngineRules(client, HOTEL))[0].undo_on_cancellation).toBe(true);
  });

  it("changing the box is not an edit: the version and the rule's changes stay", async () => {
    const { client, tables } = fakeSupabase({
      pricing_rules: [{ id: "r1", version: 4, is_active: true, is_pickup_rule: true, undo_on_cancellation: true }],
      rule_condition: [{ rule_id: "r1", ...occupancy }],
      pickup_event: [{ id: "pe1", rule_id: "r1", retired_at: null }],
    });
    expect(await updateRule("r1", { undo_on_cancellation: false }, client)).toBe(true);
    expect(tables.get("pricing_rules")![0]).toMatchObject({ version: 4, undo_on_cancellation: false });
    expect(tables.get("pickup_event")![0]).toMatchObject({ retired_at: null });
    expect(await updateRule("r1", { undo_on_cancellation: true }, client)).toBe(true);
    expect(tables.get("pricing_rules")![0]).toMatchObject({ version: 4, undo_on_cancellation: true });
  });

  it("a save row security leaves untouched (staff, viewers) says it failed, and nothing else moves", async () => {
    const { client, tables, readOnly } = fakeSupabase({
      pricing_rules: [{ id: "r1", version: 4, is_active: true, is_pickup_rule: true, undo_on_cancellation: true }],
      rule_condition: [{ rule_id: "r1", ...occupancy }],
      pickup_event: [{ id: "pe1", rule_id: "r1", retired_at: null }],
    });
    readOnly.add("r1");
    expect(await updateRule("r1", { undo_on_cancellation: false }, client)).toBe(false);
    expect(await updateRule("r1", { condition: { ...occupancy, occupancy_threshold: 0.9 } }, client)).toBe(false);
    expect(tables.get("pricing_rules")![0]).toMatchObject({ version: 4, undo_on_cancellation: true });
    expect(tables.get("rule_condition")![0]).toMatchObject({ occupancy_threshold: occupancy.occupancy_threshold });
    expect(tables.get("pickup_event")![0]).toMatchObject({ retired_at: null });
  });
});
