/**
 * The end-to-end seeds and cleanups clear a hotel's fires before its rules.
 *
 * pickup_event.rule_id references pricing_rules(id) with no ON DELETE
 * (02_supabase_schema.sql), so a seed re-run after an evaluation has written
 * fires raises 23503 on `delete from public.pricing_rules` and the whole
 * `do $$` block rolls back. The seed that was missing its delete said in a
 * comment that it had one.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../../..");

const FILES = [
  "05_supabase_e2e_test_seed.sql",
  "07_supabase_e2e_test_cleanup.sql",
  "08_supabase_e2e_think_seed.sql",
  "09_supabase_e2e_cloudbeds_seed.sql",
  "10_supabase_e2e_hotel4_cloudbeds_seed.sql",
];

describe("the end-to-end SQL files", () => {
  it.each(FILES)("%s clears pickup_event before it deletes the rules", (file) => {
    const sql = readFileSync(resolve(ROOT, file), "utf8");
    const fires = sql.indexOf("delete from public.pickup_event");
    const rules = sql.indexOf("delete from public.pricing_rules");
    expect(rules).toBeGreaterThan(-1);
    expect(fires).toBeGreaterThan(-1);
    expect(fires).toBeLessThan(rules);
  });
});
