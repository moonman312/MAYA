// Stress-test wave 1: sync → evaluate(90d) → push → Cloudbeds readback,
// asserting each scenario's exact expected outcome from the engine math.
//   npx tsx scripts/cb-stress-wave1.mts
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { runCloudbedsSyncForHotel } from "../src/lib/cloudbeds/sync-hotel";
import { evaluateHotel } from "../src/lib/engine/index";
import { pushRatesForHotel } from "../supabase/functions/_shared/pms/rate-push";
import { createCloudbedsRateAdapter } from "../supabase/functions/_shared/cloudbeds/rate-push";

const HOTEL = "5846fcc4-4590-400c-8b08-50bd61ccdbf4";
const Q = "aaf5f090-705d-4e64-a616-2412330b2f23";
const K = "a04fa35b-3224-4650-9570-9b5b0cff39c6";
const CBQ = "3142970"; // cloudbeds base rateID queen
const CBK = "3142971"; // king

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

// ── SYNC ──
const sync = await runCloudbedsSyncForHotel(admin, HOTEL);
if (!sync.ok) throw new Error(`sync failed: ${sync.error}`);
console.log(`[SYNC ${el()}] rows upserted ${sync.reservationRowsUpserted}`);

const COUNTS: Record<string, number> = {
  "2026-10-05": 3, "2026-08-17": 1, "2026-10-12": 3, "2026-10-15": 4, "2026-10-19": 3, "2026-10-26": 4,
};
for (const [d, want] of Object.entries(COUNTS)) {
  const { data } = await admin.from("reservations").select("id").eq("hotel_id", HOTEL).eq("stay_date", d);
  const got = data?.length ?? 0;
  console.log(`  ${d}: ${got}/${want} room-nights ${got >= want ? "✓" : "✗ MISSING"}`);
}

// ── EVALUATE (90d covers October) ──
const ev = await evaluateHotel(admin, HOTEL, undefined, 90);
console.log(`[EVALUATE ${el()}]`, JSON.stringify(ev));

// ── ASSERTIONS ──
type Expect = { date: string; rt: string; label: string; final: number | null; ladder: number | null };
const EXPECT: Expect[] = [
  { date: "2026-10-05", rt: Q, label: "S1 queen +15%", final: 182.85, ladder: 23.85 },
  { date: "2026-10-05", rt: K, label: "S1 king +15%", final: 182.85, ladder: 23.85 },
  { date: "2026-10-12", rt: Q, label: "S3 queen +$20", final: 179.0, ladder: 20.0 },
  { date: "2026-10-12", rt: K, label: "S3 king +$20", final: 179.0, ladder: 20.0 },
  { date: "2026-10-15", rt: Q, label: "S4 queen UNTOUCHED", final: 159.0, ladder: 0.0 },
  { date: "2026-10-15", rt: K, label: "S4 king +12% (cross)", final: 178.08, ladder: 19.08 },
  { date: "2026-10-19", rt: Q, label: "S5 queen stack", final: 183.65, ladder: 24.65 },
  { date: "2026-10-19", rt: K, label: "S5 king stack", final: 183.65, ladder: 24.65 },
  { date: "2026-10-26", rt: Q, label: "S7 queen pickup +7%", final: 170.13, ladder: 0.0 },
  { date: "2026-10-26", rt: K, label: "S7 king pickup +7%", final: 170.13, ladder: 0.0 },
];

let pass = 0, fail = 0;
for (const e of EXPECT) {
  const { data: pub } = await admin
    .from("published_price").select("price, base_price")
    .eq("hotel_id", HOTEL).eq("stay_date", e.date).eq("room_type_id", e.rt).maybeSingle();
  const { data: aud } = await admin
    .from("evaluation_audit")
    .select("base_price, ladder_subtotal_delta, pickup_subtotal_delta, final_price")
    .eq("hotel_id", HOTEL).eq("stay_date", e.date).eq("room_type_id", e.rt)
    .order("evaluated_at", { ascending: false }).limit(1).maybeSingle();
  const price = pub ? Number(pub.price) : null;
  const ok = price === e.final;
  console.log(`${ok ? "PASS" : "FAIL"} ${e.label}: published $${price} (want $${e.final}) | audit: base $${aud?.base_price} ladder ${aud?.ladder_subtotal_delta} pickup ${aud?.pickup_subtotal_delta}`);
  ok ? pass++ : fail++;
}

// S2 relative assertion (background pickup events possible on Aug 17)
for (const [rt, name] of [[Q, "queen"], [K, "king"]] as const) {
  const { data: aud } = await admin
    .from("evaluation_audit")
    .select("base_price, ladder_subtotal_delta, pickup_subtotal_delta, final_price")
    .eq("hotel_id", HOTEL).eq("stay_date", "2026-08-17").eq("room_type_id", rt)
    .order("evaluated_at", { ascending: false }).limit(1).maybeSingle();
  if (!aud) { console.log(`S2 ${name}: no audit row yet`); fail++; continue; }
  const base = Number(aud.base_price);
  const wantLadder = -(Math.round(base * 10) / 100);
  const gotLadder = Number(aud.ladder_subtotal_delta);
  const ok = Math.abs(gotLadder - wantLadder) < 0.02;
  console.log(`${ok ? "PASS" : "FAIL"} S2 ${name} −10% window: base $${base} ladder ${gotLadder} (want ~${wantLadder}) pickup bg ${aud.pickup_subtotal_delta} final $${aud.final_price}`);
  ok ? pass++ : fail++;
}

// S7 pickup event existence
const { data: pev } = await admin
  .from("pickup_event").select("room_type_id, applied_at, action_value")
  .eq("hotel_id", HOTEL).eq("stay_date", "2026-10-26");
console.log(`S7 pickup events: ${pev?.length ?? 0} (want 2) ${JSON.stringify(pev)}`);
(pev?.length === 2) ? pass++ : fail++;

// ── PUSH ──
const secretRes = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/pms_secret_get`, {
  method: "POST",
  headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY!, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ p_hotel_id: HOTEL, p_pms_type: "cloudbeds" }),
});
const secretRaw = await secretRes.json();
const secret = typeof secretRaw === "string" ? JSON.parse(secretRaw) : secretRaw;
const adapter = createCloudbedsRateAdapter({
  accessToken: secret.accessToken,
  tokenType: secret.tokenType ?? "Bearer",
  baseUrl: "https://api.cloudbeds.com/api/v1.2",
  propertyId: secret.propertyId,
});
const push = await pushRatesForHotel(admin, HOTEL, adapter, { pushHorizonDays: 90 });
console.log(`[PUSH ${el()}]`, JSON.stringify(push));

// ── CLOUDBEDS READBACK (poll up to 3 min) ──
const WANTS: Record<string, { q: number; k: number }> = {
  "2026-10-05": { q: 182.85, k: 182.85 },
  "2026-10-12": { q: 179.0, k: 179.0 },
  "2026-10-15": { q: 159.0, k: 178.08 },
  "2026-10-19": { q: 183.65, k: 183.65 },
  "2026-10-26": { q: 170.13, k: 170.13 },
};
for (let i = 0; i < 12; i++) {
  await new Promise((r) => setTimeout(r, 15000));
  let allOk = true;
  const lines: string[] = [];
  for (const [d, w] of Object.entries(WANTS)) {
    const u = new URL("https://api.cloudbeds.com/api/v1.2/getRatePlans");
    u.searchParams.set("startDate", d);
    const nx = new Date(d + "T00:00:00Z"); nx.setUTCDate(nx.getUTCDate() + 1);
    u.searchParams.set("endDate", nx.toISOString().slice(0, 10));
    const res = await fetch(u, { headers: { Authorization: `Bearer ${secret.accessToken}` } });
    const body = (await res.json()) as { data?: Array<{ rateID: string; roomRate: number }> };
    const q = body.data?.find((p) => p.rateID === CBQ)?.roomRate;
    const k = body.data?.find((p) => p.rateID === CBK)?.roomRate;
    const ok = q === w.q && k === w.k;
    if (!ok) allOk = false;
    lines.push(`  ${d}: Q $${q} (want ${w.q}) K $${k} (want ${w.k}) ${ok ? "✓" : "…"}`);
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log(`[READBACK t+${(i + 1) * 15}s]`);
  for (const l of lines) console.log(l);
  if (allOk) { console.log(`\nALL RATES LIVE IN CLOUDBEDS (${el()} total) — wave1: ${pass} pass, ${fail} fail pre-push`); process.exit(0); }
}
console.log(`\nwave1 assertions: ${pass} pass, ${fail} fail; some rates not yet visible in Cloudbeds after 3min`);
