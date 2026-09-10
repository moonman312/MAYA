/* eslint-disable @typescript-eslint/no-explicit-any -- live vendor JSON. */
// Live proof of the Cloudbeds appstate_changed subscription, through MAYA's own
// code path. Subscribes the sandbox property, lists it back, then optionally
// removes it again with --cleanup.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { ensureAppStateWebhook, appStateWebhookUrl } from "../src/lib/pms/cloudbeds-webhooks";
import {
  cloudbedsGetWebhooks,
  cloudbedsDeleteWebhook,
} from "../supabase/functions/_shared/cloudbeds/client";

const HOTEL = "5846fcc4-4590-400c-8b08-50bd61ccdbf4";
const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
// The subscription must point somewhere Cloudbeds can actually reach.
process.env.MAYA_INVITE_REDIRECT_BASE = "https://maya-rms.com";

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});
const { data: raw } = await admin.rpc("pms_secret_get", { p_hotel_id: HOTEL, p_pms_type: "cloudbeds" });
const s = typeof raw === "string" ? JSON.parse(raw) : raw;

const body = new URLSearchParams({
  grant_type: "refresh_token", client_id: env.CLOUDBEDS_CLIENT_ID!,
  client_secret: env.CLOUDBEDS_CLIENT_SECRET!, refresh_token: s.refreshToken,
});
const tr = await fetch("https://hotels.cloudbeds.com/api/v1.3/access_token", {
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
});
const token = (await tr.json() as any).access_token;
const creds = {
  accessToken: token, tokenType: "Bearer",
  baseUrl: "https://hotels.cloudbeds.com/api/v1.2", propertyId: s.propertyId,
};

console.log("target endpoint:", appStateWebhookUrl(HOTEL));

if (process.argv.includes("--cleanup")) {
  const subs = await cloudbedsGetWebhooks(creds);
  for (const w of subs) {
    if (w.url?.includes("/api/pms/cloudbeds/webhook/")) {
      const r = await cloudbedsDeleteWebhook(creds, w.id);
      console.log(`  deleted ${w.id} (${w.entity}/${w.action}) -> ok=${r.ok}${r.error ? " " + r.error : ""}`);
    }
  }
} else {
  console.log("\n1. subscribe (first call):", JSON.stringify(await ensureAppStateWebhook(creds, HOTEL)));
  console.log("2. subscribe again (must not duplicate):", JSON.stringify(await ensureAppStateWebhook(creds, HOTEL)));
}

console.log("\n3. what Cloudbeds now has on file:");
for (const w of await cloudbedsGetWebhooks(creds)) {
  console.log(`   id=${w.id}  ${w.entity}/${w.action}  -> ${w.url}`);
}
