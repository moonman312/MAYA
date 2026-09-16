/**
 * An in-memory Supabase that speaks enough of the query grammar to run the
 * whole engine end to end: filters, ordering, paging, single-row reads and
 * the four writes. Shared by the engine tests that need a full evaluateHotel
 * run rather than one function in isolation.
 *
 * `fault` lets a test make one table misbehave the way a pre-migration
 * database does (42703 on a column, PGRST205 on a table) or the way an outage
 * does, so deploy-order tolerance can be exercised without a real database.
 */
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

export type FakeRow = Record<string, unknown>;

export type FakeCall = {
  table: string;
  op: "select" | "insert" | "upsert" | "update" | "delete";
  columns: string;
  filters: { col: string; kind: string; value: unknown }[];
  payload: FakeRow | FakeRow[] | null;
};

export type FakeError = { code?: string; message: string };
export type FakeFault = (call: FakeCall) => FakeError | null | undefined;

export function fakeSupabase(
  seed: Record<string, FakeRow[]> = {},
  opts: { fault?: FakeFault; rpc?: (fn: string, args: unknown) => unknown } = {},
) {
  const tables: Record<string, FakeRow[]> = {};
  for (const [t, rows] of Object.entries(seed)) tables[t] = rows.map((r) => ({ ...r }));
  const calls: FakeCall[] = [];
  let nextId = 1;

  const compare = (a: unknown, b: unknown): number => {
    if (a === b) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    return (a as number) < (b as number) ? -1 : 1;
  };

  function from(table: string) {
    const rows = (tables[table] ??= []);
    const call: FakeCall = { table, op: "select", columns: "", filters: [], payload: null };
    const orders: { col: string; asc: boolean }[] = [];
    let range: [number, number] | null = null;
    let limit: number | null = null;
    let conflictKeys: string[] = [];
    let headCount = false;
    let returnWritten = false;
    let written: FakeRow[] = [];

    const passes = (r: FakeRow) =>
      call.filters.every(({ col, kind, value }) => {
        const v = r[col];
        switch (kind) {
          case "eq":
            return v === value;
          case "neq":
            return v !== value;
          case "in":
            return (value as unknown[]).includes(v);
          case "is":
            return value === null ? v == null : v === value;
          case "gte":
            return v != null && compare(v, value) >= 0;
          case "gt":
            return v != null && compare(v, value) > 0;
          case "lte":
            return v != null && compare(v, value) <= 0;
          case "lt":
            return v != null && compare(v, value) < 0;
          case "not.is":
            return value === null ? v != null : v !== value;
          default:
            return true;
        }
      });

    const matched = () => {
      let out = rows.filter(passes);
      for (const o of [...orders].reverse()) {
        out = [...out].sort((a, b) => (o.asc ? 1 : -1) * compare(a[o.col], b[o.col]));
      }
      if (range) out = out.slice(range[0], range[1] + 1);
      if (limit != null) out = out.slice(0, limit);
      return out;
    };

    const withId = (r: FakeRow): FakeRow => ({ ...r, id: r.id ?? String(nextId++) });

    const exec = (): { data: unknown; error: FakeError | null; count?: number } => {
      calls.push(call);
      const fault = opts.fault?.(call);
      if (fault) return { data: null, error: fault };
      switch (call.op) {
        case "select": {
          if (headCount) return { data: null, error: null, count: matched().length };
          return { data: matched(), error: null };
        }
        case "insert": {
          const list = Array.isArray(call.payload) ? call.payload : [call.payload!];
          written = list.map(withId);
          rows.push(...written);
          return { data: returnWritten ? written : null, error: null };
        }
        case "upsert": {
          const list = Array.isArray(call.payload) ? call.payload : [call.payload!];
          written = [];
          for (const p of list) {
            const hit = rows.find((r) => conflictKeys.every((k) => r[k] === p[k]));
            if (hit) {
              Object.assign(hit, p);
              written.push(hit);
            } else {
              const fresh = withId(p);
              rows.push(fresh);
              written.push(fresh);
            }
          }
          return { data: returnWritten ? written : null, error: null };
        }
        case "update": {
          written = rows.filter(passes);
          for (const r of written) Object.assign(r, call.payload as FakeRow);
          return { data: returnWritten ? written : null, error: null };
        }
        case "delete": {
          // In place, so every builder sharing this table array sees it.
          for (let i = rows.length - 1; i >= 0; i--) if (passes(rows[i])) rows.splice(i, 1);
          return { data: null, error: null };
        }
      }
    };

    const filter = (kind: string) => (col: string, value: unknown) => {
      call.filters.push({ col, kind, value });
      return b;
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {
      select: (cols = "*", o?: { count?: string; head?: boolean }) => {
        if (call.op === "select") call.columns = cols;
        else returnWritten = true;
        if (o?.head) headCount = true;
        return b;
      },
      insert: (p: FakeRow | FakeRow[]) => ((call.op = "insert"), (call.payload = p), b),
      upsert: (p: FakeRow | FakeRow[], o?: { onConflict?: string }) => (
        (call.op = "upsert"),
        (call.payload = p),
        (conflictKeys = (o?.onConflict ?? "id").split(",")),
        b
      ),
      update: (p: FakeRow) => ((call.op = "update"), (call.payload = p), b),
      delete: () => ((call.op = "delete"), b),
      eq: filter("eq"),
      neq: filter("neq"),
      in: filter("in"),
      is: filter("is"),
      gte: filter("gte"),
      gt: filter("gt"),
      lte: filter("lte"),
      lt: filter("lt"),
      not: (col: string, op: string, value: unknown) => (
        call.filters.push({ col, kind: `not.${op}`, value }), b
      ),
      order: (col: string, o?: { ascending?: boolean }) => (
        orders.push({ col, asc: o?.ascending ?? true }), b
      ),
      limit: (n: number) => ((limit = n), b),
      range: (a: number, z: number) => ((range = [a, z]), b),
      maybeSingle: () => {
        const r = exec();
        if (r.error) return Promise.resolve({ data: null, error: r.error });
        const list = (r.data as FakeRow[] | null) ?? written;
        return Promise.resolve({ data: list[0] ?? null, error: null });
      },
      single: () => {
        const r = exec();
        if (r.error) return Promise.resolve({ data: null, error: r.error });
        const list = (r.data as FakeRow[] | null) ?? written;
        return Promise.resolve(
          list[0]
            ? { data: list[0], error: null }
            : { data: null, error: { code: "PGRST116", message: "no rows" } },
        );
      },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(exec()).then(res, rej),
    };
    return b;
  }

  const client = {
    from,
    rpc: (fn: string, args: unknown) =>
      Promise.resolve({ data: opts.rpc ? opts.rpc(fn, args) : null, error: null }),
  };

  return { client: client as unknown as SupabaseClient, tables, calls };
}

/** A PostgREST "column does not exist" error, as the client surfaces it. */
export function missingColumn(table: string, column: string): FakeError {
  return { code: "42703", message: `column ${table}.${column} does not exist` };
}

/**
 * A missing table, as PostgREST actually reports it: its schema cache answers
 * before Postgres does, so the client sees PGRST205, never 42P01. The raw
 * Postgres shape is kept as `missingRelationPg` for the code paths that must
 * accept both.
 */
export function missingRelation(table: string): FakeError {
  return {
    code: "PGRST205",
    message: `Could not find the table 'public.${table}' in the schema cache`,
  };
}

/** The same gap as Postgres itself words it (42P01). */
export function missingRelationPg(table: string): FakeError {
  return { code: "42P01", message: `relation "public.${table}" does not exist` };
}

/** True when this call names the column anywhere: select list, a filter, or a write payload. */
export function callTouchesColumn(call: FakeCall, column: string): boolean {
  if (call.columns.includes(column)) return true;
  if (call.filters.some((f) => f.col === column)) return true;
  const payload = call.payload;
  if (!payload) return false;
  const list = Array.isArray(payload) ? payload : [payload];
  return list.some((p) => Object.prototype.hasOwnProperty.call(p, column));
}

describe("fake supabase", () => {
  it("filters, orders, pages and reads single rows", async () => {
    const { client } = fakeSupabase({
      t: [
        { id: "1", k: "a", n: 3 },
        { id: "2", k: "a", n: 1 },
        { id: "3", k: "b", n: 2 },
      ],
    });
    const { data } = await client.from("t").select("*").eq("k", "a").order("n", { ascending: true });
    expect(data?.map((r) => r.id)).toEqual(["2", "1"]);
    const { data: paged } = await client.from("t").select("*").order("n").range(1, 1);
    expect(paged?.map((r) => r.id)).toEqual(["3"]);
    const { data: one } = await client.from("t").select("*").eq("k", "zzz").maybeSingle();
    expect(one).toBeNull();
  });

  it("upserts on the conflict key and deletes by filter", async () => {
    const { client, tables } = fakeSupabase({ t: [{ id: "1", k: "a", n: 1 }] });
    await client.from("t").upsert({ id: "1", k: "a", n: 9 }, { onConflict: "id" });
    expect(tables.t).toEqual([{ id: "1", k: "a", n: 9 }]);
    await client.from("t").delete().eq("k", "a");
    expect(tables.t).toEqual([]);
  });

  it("raises the injected fault as a PostgREST-shaped error", async () => {
    const { client } = fakeSupabase({}, {
      fault: (c) => (c.table === "t" ? missingColumn("t", "x") : null),
    });
    const { error } = await client.from("t").select("x");
    expect(error?.code).toBe("42703");
  });
});
