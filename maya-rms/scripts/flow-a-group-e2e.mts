/* eslint-disable @typescript-eslint/no-explicit-any */
// Flow A group bundle, end to end against the live database.
//
// A real group grant is the one thing we cannot fake — our sandbox is a single
// property account — so this parks TWO properties the way handleMarketplaceConnect
// does (inert hotel + credentials + a claim sharing one group_key) and then puts
// the real redeemMarketplaceClaim through it. The half with the schema dependency
// is therefore exercised for real: real rows, real RLS, real writes.
//
// Prereq (tsx cannot resolve server-only):
//   mkdir -p node_modules/server-only \
//     && printf '{"name":"server-only","main":"index.js"}' > node_modules/server-only/package.json \
//     && echo 'module.exports = {};' > node_modules/server-only/index.js \
//     && npx tsx scripts/flow-a-group-e2e.mts; rm -rf node_modules/server-only
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { redeemMarketplaceClaim } from "../src/lib/pms/marketplace-claim";

const env = Object.fromEntries(readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n").filter((l)=>l.includes("=")&&!l.startsWith("#")).map((l)=>[l.slice(0,l.indexOf("=")),l.slice(l.indexOf("=")+1).trim()]));
for (const [k,v] of Object.entries(env)) process.env[k] ??= v as string;
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth:{persistSession:false} });

const GROUP = `cloudbeds:group:TEST${Date.now()}`;
const props = [
  { pid: `TESTG-${Date.now()}-A`, name: `Group Test Alpha ${Date.now()}` },
  { pid: `TESTG-${Date.now()}-B`, name: `Group Test Beta ${Date.now()}` },
];
const made: { hotelId: string; token: string }[] = [];

console.log("STEP 1 — park two properties from one grant, sharing a group_key");
for (const p of props) {
  const { data: h, error } = await admin.from("hotels").insert({
    name: p.name, timezone: "UTC", currency: "USD", is_active: false,
    setup_pending_at: new Date().toISOString(), external_enterprise_id: `cloudbeds:${p.pid}`,
  }).select("id").single();
  if (error) throw new Error(`hotel: ${error.message}`);
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g,"");
  const { error: cErr } = await admin.from("pms_marketplace_claims").insert({
    token, hotel_id: h.id, pms_type: "cloudbeds",
    external_property_id: `cloudbeds:${p.pid}`, property_name: p.name,
    group_key: GROUP, expires_at: new Date(Date.now()+86400000).toISOString(),
  });
  if (cErr) throw new Error(`claim: ${cErr.message}`);
  await admin.from("pms_connections").upsert({ hotel_id: h.id, pms_type: "cloudbeds", status: "pending", updated_at: new Date().toISOString() }, { onConflict: "hotel_id,pms_type" });
  made.push({ hotelId: h.id, token });
  console.log(`  parked ${p.name} -> hotel ${h.id.slice(0,8)}`);
}

console.log("\nSTEP 2 — the owner redeems ONE of the two links");
const { data: users } = await admin.auth.admin.listUsers({ perPage: 200 });
const owner = users!.users.find((u)=>u.email==="maya-test-owner@modern-hospitality-solutions.com")!;
const res = await redeemMarketplaceClaim(made[0].token, owner.id);
console.log("  ->", JSON.stringify(res));

console.log("\nSTEP 3 — BOTH properties must now be real and owned");
for (const m of made) {
  const { data: h } = await admin.from("hotels").select("name,is_active").eq("id", m.hotelId).single();
  const { data: mem } = await admin.from("hotel_memberships").select("role").eq("hotel_id", m.hotelId).eq("user_id", owner.id);
  const { data: st } = await admin.from("hotel_settings").select("simulation_mode").eq("hotel_id", m.hotelId).maybeSingle();
  const { data: job } = await admin.from("import_jobs").select("status").eq("hotel_id", m.hotelId).maybeSingle();
  const { data: cl } = await admin.from("pms_marketplace_claims").select("claimed_at").eq("hotel_id", m.hotelId).maybeSingle();
  const ok = h!.is_active && mem?.length===1 && st?.simulation_mode===true && !!job && !!cl?.claimed_at;
  console.log(`  ${ok?"PASS":"FAIL"} ${h!.name}: active=${h!.is_active} member=${mem?.[0]?.role ?? "-"} sim=${st?.simulation_mode} import=${job?.status ?? "-"} ticketBurned=${!!cl?.claimed_at}`);
}

console.log("\nSTEP 4 — the sibling's link is spent too, so it cannot be claimed again");
const second = await redeemMarketplaceClaim(made[1].token, "00000000-0000-0000-0000-000000000000");
console.log(`  -> ${JSON.stringify(second)}`);

// cleanup
for (const m of made) {
  await admin.from("pms_marketplace_claims").delete().eq("hotel_id", m.hotelId);
  await admin.from("import_jobs").delete().eq("hotel_id", m.hotelId);
  await admin.from("onboarding_states").delete().eq("hotel_id", m.hotelId);
  await admin.from("hotel_settings").delete().eq("hotel_id", m.hotelId);
  await admin.from("hotel_memberships").delete().eq("hotel_id", m.hotelId);
  await admin.from("pms_connections").delete().eq("hotel_id", m.hotelId);
  await admin.from("hotels").delete().eq("id", m.hotelId);
}
console.log("\ncleaned up both test properties");
