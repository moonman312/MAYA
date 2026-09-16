// Per-table query-time profile of one deep run against the sandbox.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { evaluateHotel } from "../src/lib/engine/index";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

const stats = new Map<string, { n: number; ms: number }>();
const bump = (k: string, ms: number) => {
  const s = stats.get(k) ?? { n: 0, ms: 0 };
  s.n++; s.ms += ms; stats.set(k, s);
};

const target = admin as any;
const origFrom = target.from.bind(target);
target.from = (table: string) => {
  const b = origFrom(table);
  const wrap = (obj: any) => new Proxy(obj, {
    get(t, prop) {
      const v = t[prop];
      if (prop === "then") {
        const t0 = Date.now();
        return (res: any, rej: any) => v.call(t, (x: any) => { bump(table, Date.now() - t0); return res(x); }, rej);
      }
      if (typeof v === "function") {
        return (...args: any[]) => {
          const r = v.apply(t, args);
          return r && typeof r === "object" && ("then" in r || "eq" in r || "select" in r) ? wrap(r) : r;
        };
      }
      return v;
    },
  });
  return wrap(b);
};

const t0 = Date.now();
const res = await evaluateHotel(admin, "5846fcc4-4590-400c-8b08-50bd61ccdbf4", undefined, 396);
console.log(`total ${(Date.now() - t0) / 1000}s`, JSON.stringify(res));
const rows = [...stats.entries()].sort((a, b) => b[1].ms - a[1].ms);
for (const [k, s] of rows) console.log(`${k}: ${s.n} queries, ${(s.ms / 1000).toFixed(1)}s`);
