/* eslint-disable @typescript-eslint/no-explicit-any -- ad-hoc probe against live rows. */
// Checks the new includeInactive path on listEngineRules against real data:
// the simulator is useless if it can't see the rules a property has switched
// off, and that query is the only new one behind it.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { listEngineRules } from "../src/lib/rules-store";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

const { data: hotels } = await admin.from("hotels").select("id, name").limit(20);
for (const h of hotels ?? []) {
  const active = await listEngineRules(admin as any, h.id);
  const all = await listEngineRules(admin as any, h.id, { includeInactive: true });
  if (all.length === 0) continue;
  console.log(`\n${h.name} (${h.id.slice(0, 8)}) — active ${active.length} / all ${all.length}`);
  for (const r of all) {
    const cond = Object.entries(r.condition).filter(([, v]) => v != null).map(([k, v]) => `${k}=${v}`).join(" ");
    console.log(
      `   ${r.is_active ? "ON " : "OFF"} ${r.is_pickup_rule ? "event " : "ladder"} ` +
      `${r.name.slice(0, 30).padEnd(30)} ${r.action_direction} ${r.action_value}${r.action_type === "percent" ? "%" : "$"} ` +
      `signal=${r.signal_room_type_ids.length} affected=${r.affected_room_type_ids.length} dow=${r.dow_mask} | ${cond.slice(0, 80)}`,
    );
  }
}
