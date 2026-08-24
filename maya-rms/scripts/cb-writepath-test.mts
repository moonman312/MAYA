// Live exercise of the batched engine's WRITE paths against real Postgres:
// book → activate/publish, cancel → deactivate/revert, on an empty date.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { evaluateHotel } from "../src/lib/engine/index";

const H = "5846fcc4-4590-400c-8b08-50bd61ccdbf4";
const QUEEN = "aaf5f090-705d-4e64-a616-2412330b2f23";
const DATE = "2026-09-10";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

const price = async () => {
  const { data } = await admin.from("published_price").select("price").eq("hotel_id", H).eq("stay_date", DATE).eq("room_type_id", QUEEN).maybeSingle();
  return data ? Number(data.price) : null;
};
const activeStates = async () => {
  const { data } = await admin.from("ladder_rule_state").select("rule_id, is_active").eq("stay_date", DATE).eq("room_type_id", QUEEN);
  return (data ?? []).filter((r) => r.is_active).map((r) => String(r.rule_id).slice(0, 8)).sort();
};
const transitionsSince = async (ts: string) => {
  const { data } = await admin.from("ladder_transition_event").select("rule_id, transition, room_type_id").eq("hotel_id", H).eq("stay_date", DATE).gte("transitioned_at", ts);
  return (data ?? []).filter((r) => r.room_type_id === QUEEN).map((r) => `${String(r.rule_id).slice(0, 8)}:${r.transition}`).sort();
};

const t0 = new Date().toISOString();
const pre = { price: await price(), states: await activeStates() };
console.log("[pre]", JSON.stringify(pre));

const rows = [1, 2, 3].map((i) => ({
  hotel_id: H, external_reservation_id: `wptest-${i}`, room_type_id: QUEEN,
  stay_date: DATE, booking_date: "2026-08-24", booking_window_days: 17,
  current_rate: 159, base_rate: 159, raw_payload: null,
}));
const ins = await admin.from("reservations").insert(rows);
if (ins.error) throw new Error(`insert: ${ins.error.message}`);

const r1 = await evaluateHotel(admin, H, undefined, 45);
const afterBook = { price: await price(), states: await activeStates(), transitions: await transitionsSince(t0) };
console.log("[book]", JSON.stringify({ counters: { act: r1.ladder_activations, deact: r1.ladder_deactivations, pub: r1.prices_published }, ...afterBook }));

const del = await admin.from("reservations").delete().like("external_reservation_id", "wptest-%");
if (del.error) throw new Error(`delete: ${del.error.message}`);

const t1 = new Date().toISOString();
const r2 = await evaluateHotel(admin, H, undefined, 45);
const afterCancel = { price: await price(), states: await activeStates(), transitions: await transitionsSince(t1) };
console.log("[cancel]", JSON.stringify({ counters: { act: r2.ladder_activations, deact: r2.ladder_deactivations, pub: r2.prices_published }, ...afterCancel }));

const activated = afterBook.transitions.some((t) => t.endsWith(":activate"));
const deactivated = afterCancel.transitions.some((t) => t.endsWith(":deactivate"));
const priceRose = afterBook.price != null && (pre.price == null || afterBook.price > pre.price);
const priceReverted = afterCancel.price === pre.price || (pre.price == null && afterCancel.price != null);
const statesReverted = JSON.stringify(afterCancel.states) === JSON.stringify(pre.states);
console.log(activated && deactivated && priceRose && statesReverted
  ? `WRITE-PATH TEST PASSED: activate ledger ${afterBook.transitions.length} rows, price ${pre.price}→${afterBook.price}→${afterCancel.price}, states reverted, priceReverted=${priceReverted}`
  : `WRITE-PATH TEST FAILED: activated=${activated} deactivated=${deactivated} priceRose=${priceRose} statesReverted=${statesReverted} priceReverted=${priceReverted}`);
