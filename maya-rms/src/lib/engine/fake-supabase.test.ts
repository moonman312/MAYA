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
import { scaleRpc } from "./scale-rpc-model.test";

export type FakeRow = Record<string, unknown>;

export type FakeCall = {
  table: string;
  op: "select" | "insert" | "upsert" | "update" | "delete";
  columns: string;
  filters: { col: string; kind: string; value: unknown }[];
  payload: FakeRow | FakeRow[] | null;
};

export type FakeError = { code?: string; message: string };

/** Return from an rpc handler to make that call fail with `error`. */
export class FakeRpcError {
  constructor(public error: FakeError) {}
}

/** PostgREST's answer for a function no migration has created yet. */
export function missingFunction(fn: string): FakeError {
  return {
    code: "PGRST202",
    message: `Could not find the function public.${fn} without parameters in the schema cache`,
  };
}
export type FakeFault = (call: FakeCall) => FakeError | null | undefined;

export function fakeSupabase(
  seed: Record<string, FakeRow[]> = {},
  opts: {
    fault?: FakeFault;
    rpc?: (fn: string, args: unknown, tables: Record<string, FakeRow[]>) => unknown;
    /** PostgREST's db-max-rows: any read returns at most this many rows, silently. */
    maxRows?: number;
  } = {},
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

  /**
   * PostgREST's `or=(...)` grammar, the subset the engine writes:
   * `col.op.value` terms joined by commas, nested `and(...)`, and the
   * operators eq/gt/gte/lt/lte/is.null/in.(...)/not.in.(...).
   */
  const splitTop = (expr: string): string[] => {
    const out: string[] = [];
    let depth = 0;
    let cur = "";
    for (const ch of expr) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  };
  type Pred = (r: FakeRow) => boolean;
  const compileTerm = (term: string): Pred => {
    if (term.startsWith("and(") && term.endsWith(")")) {
      const parts = splitTop(term.slice(4, -1)).map(compileTerm);
      return (r) => parts.every((p) => p(r));
    }
    if (term.startsWith("or(") && term.endsWith(")")) {
      const parts = splitTop(term.slice(3, -1)).map(compileTerm);
      return (r) => parts.some((p) => p(r));
    }
    const [col, ...rest] = term.split(".");
    let op = rest.shift() ?? "";
    let negate = false;
    if (op === "not") {
      negate = true;
      op = rest.shift() ?? "";
    }
    const raw = rest.join(".");
    const list = op === "in" ? raw.replace(/^\(|\)$/g, "").split(",") : [];
    const test = (v: unknown): boolean => {
      switch (op) {
        case "eq":
          return String(v) === raw;
        case "gt":
          return v != null && String(v) > raw;
        case "gte":
          return v != null && String(v) >= raw;
        case "lt":
          return v != null && String(v) < raw;
        case "lte":
          return v != null && String(v) <= raw;
        case "is":
          return raw === "null" ? v == null : String(v) === raw;
        case "in":
          return v != null && list.includes(String(v));
        default:
          return true;
      }
    };
    return (r) => {
      const v = r[col];
      // SQL: a NULL compared with IN (...) is never true, negated or not.
      if (op === "in" && v == null) return false;
      return negate ? !test(v) : test(v);
    };
  };
  const compiledOr = new Map<string, Pred>();
  const orPasses = (r: FakeRow, expr: string) => {
    let pred = compiledOr.get(expr);
    if (!pred) {
      const terms = splitTop(expr).map(compileTerm);
      pred = (row) => terms.some((t) => t(row));
      compiledOr.set(expr, pred);
    }
    return pred(r);
  };

  /**
   * Column lists that use JSON paths (`alias:details->a->>b`) are projected
   * the way PostgREST does: `->` keeps JSON, `->>` gives text. Any other
   * select returns whole rows, as the fake always has.
   */
  const project = (rows: FakeRow[], columns: string): FakeRow[] => {
    if (!columns.includes("->")) return rows;
    const items = splitTop(columns).map((raw) => {
      const item = raw.trim();
      const colon = item.indexOf(":");
      const expr = colon >= 0 && !item.slice(0, colon).includes("-") ? item.slice(colon + 1) : item;
      const alias = colon >= 0 && expr !== item ? item.slice(0, colon) : null;
      const parts = expr.split(/(->>|->)/);
      const col = parts[0];
      const steps: { op: string; key: string }[] = [];
      for (let i = 1; i < parts.length; i += 2) steps.push({ op: parts[i], key: parts[i + 1] });
      return { name: alias ?? (steps.length ? steps[steps.length - 1].key : col), col, steps };
    });
    return rows.map((r) => {
      const out: FakeRow = {};
      for (const it of items) {
        let v: unknown = r[it.col];
        for (const st of it.steps) {
          v = v != null && typeof v === "object" ? (v as Record<string, unknown>)[st.key] : undefined;
          if (v === undefined) v = null;
          if (st.op === "->>" && v != null) v = typeof v === "object" ? JSON.stringify(v) : String(v);
        }
        out[it.name] = v === undefined ? null : v;
      }
      return out;
    });
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
        if (kind === "or") return orPasses(r, String(value));
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
      if (orders.length > 0) {
        out = [...out].sort((a, b) => {
          for (const o of orders) {
            const c = compare(a[o.col], b[o.col]);
            if (c !== 0) return o.asc ? c : -c;
          }
          return 0;
        });
      }
      if (range) out = out.slice(range[0], range[1] + 1);
      if (limit != null) out = out.slice(0, limit);
      if (opts.maxRows != null) out = out.slice(0, opts.maxRows);
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
          return { data: project(matched(), call.columns), error: null };
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
      or: (expr: string) => (call.filters.push({ col: "", kind: "or", value: expr }), b),
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

  /**
   * An rpc call is a builder too: a set-returning function can be ordered
   * and paged, and is capped at maxRows like any other read. A handler that
   * returns FakeRpcError answers with that error instead.
   */
  function rpc(fn: string, args: unknown) {
    const orders: { col: string; asc: boolean }[] = [];
    let range: [number, number] | null = null;
    const exec = () => {
      calls.push({ table: `rpc:${fn}`, op: "select", columns: "", filters: [], payload: args as FakeRow });
      // Functions from the large-property migration answer from the fake's
      // own tables unless a test's handler says otherwise, so the fake
      // behaves like a migrated database by default.
      const custom = opts.rpc ? opts.rpc(fn, args, tables) : undefined;
      const out = custom === undefined ? scaleRpc(fn, args, tables) : custom;
      if (out instanceof FakeRpcError) return { data: null, error: out.error };
      if (!Array.isArray(out)) return { data: out, error: null };
      let rows = [...out] as FakeRow[];
      for (const o of [...orders].reverse()) {
        rows = [...rows].sort((a, b) => (o.asc ? 1 : -1) * compare(a[o.col], b[o.col]));
      }
      if (range) rows = rows.slice(range[0], range[1] + 1);
      if (opts.maxRows != null) rows = rows.slice(0, opts.maxRows);
      return { data: rows, error: null };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rb: any = {
      order: (col: string, o?: { ascending?: boolean }) => (orders.push({ col, asc: o?.ascending ?? true }), rb),
      range: (a: number, z: number) => ((range = [a, z]), rb),
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(exec()).then(res, rej),
    };
    return rb;
  }

  const client = { from, rpc };

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
