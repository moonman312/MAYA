/* eslint-disable @typescript-eslint/no-explicit-any */
// The bug reviewers actually hit: clicking "Connect App" twice.
//
// Before the ownership guard, the second click found the hotel row from the
// first, took the reconnect branch, minted NO ticket and sent an accountless
// visitor to a sign-in form — leaving the property unclaimable forever, because
// every later click did the same and unique(hotel_id, pms_type) meant it could
// never be re-ticketed.
//
// Run it the same way as flow-a-e2e.mts:
//   mkdir -p node_modules/server-only \
//     && printf '{"name":"server-only","main":"index.js"}' > node_modules/server-only/package.json \
//     && echo 'module.exports = {};' > node_modules/server-only/index.js \
//     && npx tsx scripts/flow-a-doubleclick-e2e.mts; rm -rf node_modules/server-only
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { handleMarketplaceConnect } from "../src/lib/pms/marketplace-connect";

const env = Object.fromEntries(readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n").filter((l)=>l.includes("=")&&!l.startsWith("#")).map((l)=>[l.slice(0,l.indexOf("=")),l.slice(l.indexOf("=")+1).trim()]));
for (const [k,v] of Object.entries(env)) process.env[k] ??= v as string;
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth:{persistSession:false} });

const { data: raw } = await admin.rpc("pms_secret_get", { p_hotel_id:"5846fcc4-4590-400c-8b08-50bd61ccdbf4", p_pms_type:"cloudbeds" });
const s = typeof raw==="string"?JSON.parse(raw):raw;

// The stored access token is only good for 8 hours and nothing refreshes it
// while the scheduled sync is down, so mint a fresh one the way the sync would.
const tr = await fetch("https://hotels.cloudbeds.com/api/v1.3/access_token", {
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "refresh_token", client_id: env.CLOUDBEDS_CLIENT_ID!, client_secret: env.CLOUDBEDS_CLIENT_SECRET!, refresh_token: s.refreshToken }),
});
const fresh: any = await tr.json();
if (!fresh.access_token) { console.log("could not refresh:", JSON.stringify(fresh).slice(0,200)); process.exit(1); }
s.accessToken = fresh.access_token;

const tokens = {
  accessToken: s.accessToken, refreshToken: s.refreshToken ?? null,
  tokenType: s.tokenType ?? "Bearer", scope: s.scope,
  expiresAt: s.expiresAt ?? new Date(Date.now()+3600_000).toISOString(),
};

const created: string[] = [];
let failed = false;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  if (!ok) failed = true;
};

console.log("CLICK 1 — Connect App");
const first = await handleMarketplaceConnect("cloudbeds", tokens);
check("hands back a claim ticket", first.kind === "claim", JSON.stringify(first));
if (first.kind !== "claim") process.exit(1);
const { data: c1 } = await admin.from("pms_marketplace_claims").select("hotel_id").eq("token", first.token).single();
created.push(c1!.hotel_id);
console.log(`         hotel ${c1!.hotel_id.slice(0,8)}  token ${first.token.slice(0,10)}...`);

console.log("\nCLICK 2 — they go back and click again, still with no account");
const second = await handleMarketplaceConnect("cloudbeds", tokens);
check("STILL hands back a claim ticket (was: reconnected, dead end)", second.kind === "claim", second.kind);
if (second.kind === "claim") {
  const { data: c2 } = await admin.from("pms_marketplace_claims").select("hotel_id").eq("token", second.token).single();
  check("reuses the same parked property rather than duplicating it", c2!.hotel_id === c1!.hotel_id, `${c2!.hotel_id.slice(0,8)} vs ${c1!.hotel_id.slice(0,8)}`);
  check("the new ticket differs from the first", second.token !== first.token);
  const { data: live } = await admin.from("pms_marketplace_claims").select("token").eq("hotel_id", c1!.hotel_id).is("claimed_at", null);
  check("exactly one live ticket for the property", (live?.length ?? 0) === 1, `${live?.length} found`);
}

console.log("\nCLICK 3 — for good measure");
const third = await handleMarketplaceConnect("cloudbeds", tokens);
check("still recoverable", third.kind === "claim", third.kind);

console.log("\ncleanup");
for (const id of [...new Set(created)]) {
  await admin.from("pms_marketplace_claims").delete().eq("hotel_id", id);
  await admin.from("pms_connections").delete().eq("hotel_id", id);
  const { error } = await admin.from("hotels").delete().eq("id", id).eq("is_active", false);
  console.log(`  removed parked hotel ${id.slice(0,8)}${error ? " — " + error.message : ""}`);
}
console.log(failed ? "\nRESULT: FAILED" : "\nRESULT: all checks passed");
process.exit(failed ? 1 : 0);
