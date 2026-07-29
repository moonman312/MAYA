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
import { createRule, updateRule, type CreateRuleInput } from "./rules-store";

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

  function matches(row: Row, filters: [string, unknown][]): boolean {
    return filters.every(([col, val]) => row[col] === val);
  }

  function builder(table: string) {
    const filters: [string, unknown][] = [];
    let pendingInsert: Row[] | null = null;
    let pendingUpdate: Row | null = null;
    let mode: "insert" | "update" | "delete" | "select" = "select";

    const api = {
      select() {
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
        const rows = tableOf(table);
        for (const r of rows) {
          if (matches(r, filters)) Object.assign(r, pendingUpdate);
        }
        return { data: null, error: null };
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
  return { client: client as any, tables, failInsertWhen };
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

  it("succeeds on a valid edit: bumps version, retires pickup events, replaces the condition", async () => {
    const { client, tables } = fakeSupabase(seedRule());
    const ok = await updateRule(
      "r1",
      { condition: { occupancy_operator: "lt", occupancy_threshold: 0.3 } },
      client,
    );
    expect(ok).toBe(true);
    expect(tables.get("pricing_rules")?.[0]).toMatchObject({ version: 2 });
    expect(tables.get("pickup_event")?.[0]).toMatchObject({ retired_at: expect.any(String) });
    expect(tables.get("rule_condition")).toHaveLength(1);
    expect(tables.get("rule_condition")?.[0]).toMatchObject({ occupancy_operator: "lt", occupancy_threshold: 0.3 });
  });
});
