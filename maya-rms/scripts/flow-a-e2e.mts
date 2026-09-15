/* eslint-disable @typescript-eslint/no-explicit-any */
// Flow A end to end against the live Cloudbeds sandbox: a stateless grant ->
// parked property -> claim ticket -> owner attached -> STILL parked, until a
// subscription lands -> live, importing. Cleans up after itself.
//
// The modules under test are server-only, which tsx cannot resolve on its own
// (vitest aliases it to src/test/server-only-stub.ts). Run it as:
//   mkdir -p node_modules/server-only \
//     && printf '{"name":"server-only","main":"index.js"}' > node_modules/server-only/package.json \
//     && echo 'module.exports = {};' > node_modules/server-only/index.js \
//     && npx tsx scripts/flow-a-e2e.mts; rm -rf node_modules/server-only
//
// To walk the real screens instead — sign up, pay with a test card, watch the
// import start — add --mint-only. That stops after parking the property, prints
// the /login?claim=... link, and leaves everything in place. Tear it down
// afterwards with --cleanup <hotelId>.
//
// Last run 2026-09-15 against sandbox property 320691.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { handleMarketplaceConnect } from "../src/lib/pms/marketplace-connect";
import { redeemMarketplaceClaim } from "../src/lib/pms/marketplace-claim";
import { activateMarketplaceHotelIfPending } from "../src/lib/pms/marketplace-activate";
import { resolveOAuthCredentials } from "../supabase/functions/_shared/pms/oauth-credentials";

const env = Object.fromEntries(readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n").filter((l)=>l.includes("=")&&!l.startsWith("#")).map((l)=>[l.slice(0,l.indexOf("=")),l.slice(l.indexOf("=")+1).trim()]));
for (const [k,v] of Object.entries(env)) process.env[k] ??= v as string;
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth:{persistSession:false} });

const mintOnly = process.argv.includes("--mint-only");
const cleanupArg = process.argv.indexOf("--cleanup");
const SANDBOX = "5846fcc4-4590-400c-8b08-50bd61ccdbf4";

async function cleanup(hotelId: string) {
  await admin.from("pms_marketplace_claims").delete().eq("hotel_id", hotelId);
  await admin.from("import_jobs").delete().eq("hotel_id", hotelId);
  await admin.from("onboarding_states").delete().eq("hotel_id", hotelId);
  await admin.from("hotel_subscriptions").delete().eq("hotel_id", hotelId);
  await admin.from("hotel_settings").delete().eq("hotel_id", hotelId);
  await admin.from("hotel_memberships").delete().eq("hotel_id", hotelId);
  await admin.from("pms_connections").delete().eq("hotel_id", hotelId);
  await admin.rpc("pms_secret_delete", { p_hotel_id: hotelId, p_pms_type: "cloudbeds" }).then(()=>{},()=>{});
  await admin.from("hotels").delete().eq("id", hotelId);
  console.log(`\ncleaned up ${hotelId.slice(0,8)}`);
}

if (cleanupArg !== -1) {
  const id = process.argv[cleanupArg + 1];
  if (!id) { console.log("usage: --cleanup <hotelId>"); process.exit(1); }
  await cleanup(id);
  process.exit(0);
}

// Real tokens from the sandbox connection — same shape the token exchange
// yields. Refreshed first: a Marketplace grant is always fresh, and the
// sandbox's own token is only as fresh as the scheduler's last visit.
const resolved = await resolveOAuthCredentials(admin as any, SANDBOX, "cloudbeds");
if ("error" in resolved) { console.log("could not refresh the sandbox token:", resolved.error); process.exit(1); }
const { data: raw } = await admin.rpc("pms_secret_get", { p_hotel_id: SANDBOX, p_pms_type:"cloudbeds" });
const s = typeof raw==="string"?JSON.parse(raw):raw;
const grant = () => ({
  accessToken: s.accessToken, refreshToken: s.refreshToken ?? null,
  tokenType: s.tokenType ?? "Bearer", scope: s.scope,
  expiresAt: s.expiresAt ?? new Date(Date.now()+3600_000).toISOString(),
});

let pass = true;
const check = (ok: boolean, label: string) => { pass &&= ok; console.log(`  ${ok ? "PASS" : "FAIL"} — ${label}`); };

console.log("STEP 1 — Cloudbeds redirects to our callback with a grant and NO state");
const outcome = await handleMarketplaceConnect("cloudbeds", grant());
console.log("  ->", JSON.stringify(outcome));
if (outcome.kind !== "claim") { console.log("FAILED — expected a claim ticket"); process.exit(1); }

const token = outcome.token;
const { data: c } = await admin.from("pms_marketplace_claims").select("hotel_id,property_name,expires_at").eq("token", token).single();
const hotelId: string = c!.hotel_id;
console.log(`  parked property "${c!.property_name}" as hotel ${hotelId.slice(0,8)}, ticket expires ${c!.expires_at}`);

if (mintOnly) {
  const base = (process.env.MAYA_INVITE_REDIRECT_BASE ?? "http://localhost:3000").replace(/\/$/, "");
  console.log("\nOpen this in a browser, sign up, and you are on the Marketplace subscribe screen:");
  console.log(`\n  ${base}/login?claim=${token}\n`);
  console.log(`Nothing was cleaned up. When you are done:  npx tsx scripts/flow-a-e2e.mts --cleanup ${hotelId}`);
  process.exit(0);
}

console.log("STEP 2 — the parked hotel must be INERT until claimed");
{
  const { data: h } = await admin.from("hotels").select("is_active,setup_pending_at").eq("id", hotelId).single();
  const { data: m } = await admin.from("hotel_memberships").select("id").eq("hotel_id", hotelId);
  const { data: conn } = await admin.from("pms_connections").select("status").eq("hotel_id", hotelId).maybeSingle();
  check(h!.is_active === false && (m?.length ?? 0) === 0 && !!h!.setup_pending_at, "prices nothing, visible to nobody");
  check(conn?.status === "pending", `connection is 'pending' (got ${conn?.status}) — the scheduler leaves those alone`);
}

console.log("STEP 3 — owner signs in and redeems the ticket: owned, still NOT live, nothing imported");
const { data: users } = await admin.auth.admin.listUsers({ perPage: 200 });
const owner = users?.users.find((u) => u.email === "maya-test-owner@modern-hospitality-solutions.com");
if (!owner) { console.log("FAILED — test owner account not found"); await cleanup(hotelId); process.exit(1); }
{
  const res = await redeemMarketplaceClaim(token, owner.id);
  console.log("  ->", JSON.stringify(res));
  const { data: h } = await admin.from("hotels").select("is_active,setup_pending_at").eq("id", hotelId).single();
  const { data: m } = await admin.from("hotel_memberships").select("role,status").eq("hotel_id", hotelId);
  const { data: st } = await admin.from("hotel_settings").select("simulation_mode").eq("hotel_id", hotelId).maybeSingle();
  const { data: conn } = await admin.from("pms_connections").select("status").eq("hotel_id", hotelId).maybeSingle();
  const { data: jobs } = await admin.from("import_jobs").select("id").eq("hotel_id", hotelId);
  check(res.ok, "claim redeemed");
  check(m?.[0]?.role === "hotel_admin" && m?.[0]?.status === "active", "owner attached as hotel_admin");
  check(st?.simulation_mode === true, "simulation mode on");
  check(h!.is_active === false && !!h!.setup_pending_at, "hotel still parked — it has not been paid for");
  check(conn?.status === "pending", "connection still 'pending'");
  check((jobs?.length ?? 0) === 0, "no import queued before payment");
}

console.log("STEP 4 — the subscription lands (what the Stripe webhook does) -> live, importing");
{
  const subId = `sub_e2e_${Date.now()}`;
  const { error } = await admin.from("hotel_subscriptions").insert({
    hotel_id: hotelId, stripe_customer_id: "cus_e2e", stripe_subscription_id: subId,
    status: "trialing", billing_interval: "month", billed_rooms: 10,
  });
  if (error) console.log("  subscription insert failed:", error.message);
  const r = await activateMarketplaceHotelIfPending(admin as any, hotelId, { requestedBy: owner.id });
  console.log("  ->", JSON.stringify(r));
  const { data: h } = await admin.from("hotels").select("is_active,setup_pending_at").eq("id", hotelId).single();
  const { data: conn } = await admin.from("pms_connections").select("status").eq("hotel_id", hotelId).maybeSingle();
  const { data: jobs } = await admin.from("import_jobs").select("status,phase").eq("hotel_id", hotelId);
  const { data: ob } = await admin.from("onboarding_states").select("path,import_job_id").eq("hotel_id", hotelId).maybeSingle();
  check(r.activated === true, "activated");
  check(h!.is_active === true && h!.setup_pending_at === null, "hotel live");
  check(conn?.status === "connected", "connection 'connected' — the scheduler will sync it now");
  check((jobs?.length ?? 0) === 1, `exactly one import job (${jobs?.[0]?.status}/${jobs?.[0]?.phase})`);
  check(ob?.path === "guided" && !!ob?.import_job_id, "onboarding state points at the import");

  const again = await activateMarketplaceHotelIfPending(admin as any, hotelId, { requestedBy: owner.id });
  const { data: jobs2 } = await admin.from("import_jobs").select("id").eq("hotel_id", hotelId);
  check(!again.activated && again.reason === "already_active" && (jobs2?.length ?? 0) === 1,
    "a second arrival (return route racing the webhook) does nothing");
}

console.log("STEP 5 — the ticket is single use");
{
  const again = await redeemMarketplaceClaim(token, "00000000-0000-0000-0000-000000000000");
  check(!again.ok && again.reason === "taken", `another user re-claiming -> ${JSON.stringify(again)}`);
}

console.log("STEP 6 — reconnect: the SAME property must land on the SAME hotel");
{
  const second = await handleMarketplaceConnect("cloudbeds", grant());
  console.log("  ->", JSON.stringify(second));
  check(second.kind === "reconnected" && second.hotelId === hotelId, "no duplicate property created");
}

await cleanup(hotelId);
console.log(pass ? "\nALL PASSED" : "\nSOME CHECKS FAILED");
process.exit(pass ? 0 : 1);
