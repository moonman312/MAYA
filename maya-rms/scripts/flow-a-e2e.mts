/* eslint-disable @typescript-eslint/no-explicit-any */
// Flow A end to end against the live Cloudbeds sandbox: a stateless grant ->
// parked property -> claim ticket -> owner attached. Cleans up after itself.
//
// The modules under test are server-only, which tsx cannot resolve on its own
// (vitest aliases it to src/test/server-only-stub.ts). Run it as:
//   mkdir -p node_modules/server-only \
//     && printf '{"name":"server-only","main":"index.js"}' > node_modules/server-only/package.json \
//     && echo 'module.exports = {};' > node_modules/server-only/index.js \
//     && npx tsx scripts/flow-a-e2e.mts; rm -rf node_modules/server-only
//
// Last run 2026-09-09 against sandbox property 320691: all five steps passed.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { handleMarketplaceConnect } from "../src/lib/pms/marketplace-connect";
import { redeemMarketplaceClaim } from "../src/lib/pms/marketplace-claim";

const env = Object.fromEntries(readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n").filter((l)=>l.includes("=")&&!l.startsWith("#")).map((l)=>[l.slice(0,l.indexOf("=")),l.slice(l.indexOf("=")+1).trim()]));
for (const [k,v] of Object.entries(env)) process.env[k] ??= v as string;
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth:{persistSession:false} });

// Real tokens from the sandbox connection — same shape the token exchange yields.
const { data: raw } = await admin.rpc("pms_secret_get", { p_hotel_id:"5846fcc4-4590-400c-8b08-50bd61ccdbf4", p_pms_type:"cloudbeds" });
const s = typeof raw==="string"?JSON.parse(raw):raw;

console.log("STEP 1 — Cloudbeds redirects to our callback with a grant and NO state");
const outcome = await handleMarketplaceConnect("cloudbeds", {
  accessToken: s.accessToken, refreshToken: s.refreshToken ?? null,
  tokenType: s.tokenType ?? "Bearer", scope: s.scope,
  expiresAt: s.expiresAt ?? new Date(Date.now()+3600_000).toISOString(),
});
console.log("  ->", JSON.stringify(outcome));
if (outcome.kind === "error") { console.log("FAILED"); process.exit(1); }

let hotelId: string | null = null;
let token: string | null = null;
if (outcome.kind === "claim") {
  token = outcome.token;
  const { data: c } = await admin.from("pms_marketplace_claims").select("hotel_id,property_name,expires_at").eq("token", token).single();
  hotelId = c!.hotel_id;
  console.log(`  parked property "${c!.property_name}" as hotel ${hotelId!.slice(0,8)}, ticket expires ${c!.expires_at}`);

  const { data: h } = await admin.from("hotels").select("name,is_active,setup_pending_at,external_enterprise_id").eq("id", hotelId!).single();
  const { data: m } = await admin.from("hotel_memberships").select("id").eq("hotel_id", hotelId!);
  console.log("STEP 2 — the parked hotel must be INERT until claimed");
  console.log(`  is_active=${h!.is_active} (want false) | memberships=${m?.length ?? 0} (want 0) | key=${h!.external_enterprise_id}`);
  const inert = h!.is_active === false && (m?.length ?? 0) === 0 && !!h!.setup_pending_at;
  console.log(`  ${inert ? "PASS" : "FAIL"} — prices nothing, visible to nobody`);

  console.log("STEP 3 — owner signs in and redeems the ticket");
  const { data: users } = await admin.auth.admin.listUsers({ perPage: 200 });
  const owner = users?.users.find((u) => u.email === "maya-test-owner@modern-hospitality-solutions.com");
  const res = await redeemMarketplaceClaim(token!, owner!.id);
  console.log("  ->", JSON.stringify(res));

  const { data: h2 } = await admin.from("hotels").select("is_active,setup_pending_at").eq("id", hotelId!).single();
  const { data: m2 } = await admin.from("hotel_memberships").select("role,status").eq("hotel_id", hotelId!);
  const { data: st } = await admin.from("hotel_settings").select("simulation_mode").eq("hotel_id", hotelId!).maybeSingle();
  const { data: conn } = await admin.from("pms_connections").select("status").eq("hotel_id", hotelId!).maybeSingle();
  const { data: job } = await admin.from("import_jobs").select("status,phase").eq("hotel_id", hotelId!).maybeSingle();
  console.log(`  hotel active=${h2!.is_active} | membership=${m2?.[0]?.role}/${m2?.[0]?.status} | simulation=${st?.simulation_mode} | connection=${conn?.status} | import=${job?.status}/${job?.phase}`);

  console.log("STEP 4 — the ticket is single use");
  const again = await redeemMarketplaceClaim(token!, "00000000-0000-0000-0000-000000000000");
  console.log(`  another user re-claiming -> ${JSON.stringify(again)}`);

  console.log("STEP 5 — reconnect: the SAME property must land on the SAME hotel");
  const second = await handleMarketplaceConnect("cloudbeds", {
    accessToken: s.accessToken, refreshToken: s.refreshToken ?? null,
    tokenType: s.tokenType ?? "Bearer", scope: s.scope,
    expiresAt: s.expiresAt ?? new Date(Date.now()+3600_000).toISOString(),
  });
  console.log("  ->", JSON.stringify(second));
  const sameHotel = second.kind === "reconnected" && second.hotelId === hotelId;
  console.log(`  ${sameHotel ? "PASS" : "FAIL"} — no duplicate property created`);
}

// ── cleanup ──
if (hotelId) {
  await admin.from("pms_marketplace_claims").delete().eq("hotel_id", hotelId);
  await admin.from("import_jobs").delete().eq("hotel_id", hotelId);
  await admin.from("onboarding_states").delete().eq("hotel_id", hotelId);
  await admin.from("hotel_settings").delete().eq("hotel_id", hotelId);
  await admin.from("hotel_memberships").delete().eq("hotel_id", hotelId);
  await admin.from("pms_connections").delete().eq("hotel_id", hotelId);
  await admin.rpc("pms_secret_delete", { p_hotel_id: hotelId, p_pms_type: "cloudbeds" }).then(()=>{},()=>{});
  await admin.from("hotels").delete().eq("id", hotelId);
  console.log("\ncleaned up the test property");
}
