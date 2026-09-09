// Wave 2 finale: cancellations arrive → S1 ladder REVERTS to base, S7 pickup PERSISTS.
//   npx tsx scripts/cb-stress-wave2.mts
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { runCloudbedsSyncForHotel } from "../src/lib/cloudbeds/sync-hotel";
import { evaluateHotel } from "../src/lib/engine/index";
import { pushRatesForHotel } from "../supabase/functions/_shared/pms/rate-push";
import { createCloudbedsRateAdapter } from "../supabase/functions/_shared/cloudbeds/rate-push";

const HOTEL = "5846fcc4-4590-400c-8b08-50bd61ccdbf4";
const Q = "aaf5f090-705d-4e64-a616-2412330b2f23";
const K = "a04fa35b-3224-4650-9570-9b5b0cff39c6";
const CBQ = "3142970", CBK = "3142971";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

const sync = await runCloudbedsSyncForHotel(admin, HOTEL);
if (!sync.ok) throw new Error(sync.error);
console.log(`[SYNC ${el()}] upserted ${sync.reservationRowsUpserted}, canceled rows deleted ${JSON.stringify((sync as { ingest?: { canceledRowIdsDeleted?: number } }).ingest?.canceledRowIdsDeleted)}`);

for (const [d, want] of [["2026-10-05", 1], ["2026-10-26", 3]] as const) {
  const { data } = await admin.from("reservations").select("id").eq("hotel_id", HOTEL).eq("stay_date", d);
  console.log(`  ${d}: ${data?.length}/${want} room-nights ${data?.length === want ? "✓" : "✗"}`);
}

const ev = await evaluateHotel(admin, HOTEL, undefined, 90);
console.log(`[EVALUATE ${el()}]`, JSON.stringify(ev));

let pass = 0, fail = 0;
const EXPECT = [
  { date: "2026-10-05", rt: Q, label: "S1 queen REVERTED", final: 159.0 },
  { date: "2026-10-05", rt: K, label: "S1 king REVERTED", final: 159.0 },
  { date: "2026-10-26", rt: Q, label: "S7 queen PERSISTS", final: 170.13 },
  { date: "2026-10-26", rt: K, label: "S7 king PERSISTS", final: 170.13 },
];
for (const e of EXPECT) {
  const { data: pub } = await admin.from("published_price").select("price").eq("hotel_id", HOTEL).eq("stay_date", e.date).eq("room_type_id", e.rt).maybeSingle();
  const ok = pub && Number(pub.price) === e.final;
  console.log(`${ok ? "PASS" : "FAIL"} ${e.label}: $${pub?.price} (want $${e.final})`);
  ok ? pass++ : fail++;
}

const secretRes = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/pms_secret_get`, {
  method: "POST",
  headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY!, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ p_hotel_id: HOTEL, p_pms_type: "cloudbeds" }),
});
const secretRaw = await secretRes.json();
const secret = typeof secretRaw === "string" ? JSON.parse(secretRaw) : secretRaw;
const adapter = createCloudbedsRateAdapter({
  accessToken: secret.accessToken, tokenType: secret.tokenType ?? "Bearer",
  baseUrl: "https://api.cloudbeds.com/api/v1.2", propertyId: secret.propertyId,
});
const push = await pushRatesForHotel(admin, HOTEL, adapter, { pushHorizonDays: 90 });
console.log(`[PUSH ${el()}]`, JSON.stringify(push));

for (let i = 0; i < 16; i++) {
  await new Promise((r) => setTimeout(r, 15000));
  const rates: Record<string, { q?: number; k?: number }> = {};
  for (const d of ["2026-10-05", "2026-10-26"]) {
    const u = new URL("https://api.cloudbeds.com/api/v1.2/getRatePlans");
    u.searchParams.set("startDate", d);
    const nx = new Date(d + "T00:00:00Z"); nx.setUTCDate(nx.getUTCDate() + 1);
    u.searchParams.set("endDate", nx.toISOString().slice(0, 10));
    const res = await fetch(u, { headers: { Authorization: `Bearer ${secret.accessToken}` } });
    const body = (await res.json()) as { data?: Array<{ rateID: string; roomRate: number }> };
    rates[d] = { q: body.data?.find((p) => p.rateID === CBQ)?.roomRate, k: body.data?.find((p) => p.rateID === CBK)?.roomRate };
    await new Promise((r) => setTimeout(r, 400));
  }
  const done = rates["2026-10-05"].q === 159 && rates["2026-10-05"].k === 159 && rates["2026-10-26"].q === 170.13 && rates["2026-10-26"].k === 170.13;
  console.log(`[READBACK t+${(i + 1) * 15}s] Oct5 Q$${rates["2026-10-05"].q} K$${rates["2026-10-05"].k} (want 159/159) | Oct26 Q$${rates["2026-10-26"].q} K$${rates["2026-10-26"].k} (want 170.13/170.13)`);
  if (done) { console.log(`\nFINALE COMPLETE in ${el()}: revert pushed AND pickup held — engine asserts ${pass} pass ${fail} fail`); process.exit(0); }
}
console.log(`\nengine asserts ${pass}/${pass + fail}; Cloudbeds not fully settled in 4min`);
