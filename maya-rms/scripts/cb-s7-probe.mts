// Why doesn't S7's pickup fire? Call the engine's own gates with live data.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { loadLastAppliedByRuleDate, resolveBaselineTs } from "../src/lib/engine/pickup";
import { computeRuleMetrics } from "../src/lib/engine/metrics";
import { ruleConditionsMatch } from "../src/lib/engine/conditions";
import { buildBaselineSnapshotStore, type CellSnapshot } from "../src/lib/engine/snapshots";

const HOTEL = "5846fcc4-4590-400c-8b08-50bd61ccdbf4";
const Q = "aaf5f090-705d-4e64-a616-2412330b2f23";
const K = "a04fa35b-3224-4650-9570-9b5b0cff39c6";
const RULE_ID = "cb8dd1d7-699a-4880-9195-fde3edff79f5";
const STAY = "2026-10-26";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

const { data: ruleRow } = await admin.from("pricing_rules").select("*").eq("id", RULE_ID).single();
const { data: cond } = await admin.from("rule_condition").select("*").eq("rule_id", RULE_ID).single();
const rule = {
  ...ruleRow,
  condition: cond,
  signal_room_type_ids: [Q, K],
  affected_room_type_ids: [Q, K],
} as never;

// use the most recent snapshot ts as "current"
const { data: latest } = await admin
  .from("stay_date_snapshot").select("snapshot_ts")
  .eq("hotel_id", HOTEL).eq("stay_date", STAY).eq("room_type_id", Q)
  .order("snapshot_ts", { ascending: false }).limit(1).single();
const now = String(latest!.snapshot_ts);
console.log("using currentSnapshotTs =", now);

const lastApplied = await loadLastAppliedByRuleDate(admin, HOTEL, STAY, STAY);
const baselineTs = resolveBaselineTs(lastApplied.get(`${RULE_ID}|${STAY}`), rule, now);
console.log("baselineTs =", baselineTs);

const { data: snapRows } = await admin
  .from("stay_date_snapshot")
  .select("stay_date, room_type_id, booked_units, booked_revenue, sellable_units")
  .eq("hotel_id", HOTEL).eq("stay_date", STAY).eq("snapshot_ts", now);
const currentSnaps = new Map<string, CellSnapshot>();
for (const r of snapRows ?? []) {
  currentSnaps.set(`${r.stay_date}|${r.room_type_id}`, {
    booked_units: Number(r.booked_units),
    booked_revenue: Number(r.booked_revenue),
    sellable_units: Number(r.sellable_units),
    snapshot_ts: now,
  });
}

const store = await buildBaselineSnapshotStore(admin, HOTEL, [{ baselineTs: baselineTs!, stayDate: STAY }], [Q, K]);
const metrics = await computeRuleMetrics(rule, STAY, "2026-08-11", currentSnaps, store, baselineTs!);
console.log("metrics =", JSON.stringify(metrics, null, 1));
console.log("conditions match =", ruleConditionsMatch(rule, metrics));
