/**
 * The migration's deploy runbook names every edge function that carries the
 * code this build changed: the booking unit lives in
 * observations/booking-rows.ts and the engine's row fallback in
 * engine/booking-speed-provider.ts, and every scheduled sync runs the engine.
 * A function left on the old bundle would count rooms on its fallback and
 * read bookings from the migrated function, and its nights would read
 * differently from the app's.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const FUNCTIONS = resolve(__dirname, "../../../supabase/functions");
const MIGRATION = resolve(__dirname, "../../../../99_supabase_migration_booking_speed_counts_bookings_v1.sql");

/** Shared modules this build changed the behaviour of. */
const CHANGED = [
  "supabase/functions/_shared/observations/booking-rows.ts",
  "supabase/functions/_shared/engine/booking-speed-provider.ts",
];

/** Every file an edge function's bundle pulls in, following relative imports. */
function importClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [normalize(entry)];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    seen.add(file);
    for (const m of source.matchAll(/from\s+"(\.[^"]+)"/g)) {
      stack.push(normalize(join(dirname(file), m[1])));
    }
  }
  return seen;
}

describe("the booking speed counts bookings migration's deploy list", () => {
  it("names every function whose bundle carries code this build changed", () => {
    // The header is everything before the transaction opens.
    const source = readFileSync(MIGRATION, "utf8");
    const header = source.slice(0, source.indexOf("\nbegin;"));
    const names = readdirSync(FUNCTIONS, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== "_shared")
      .map((d) => d.name);
    expect(names.length).toBeGreaterThan(0);

    const carries = names.filter((name) => {
      const closure = importClosure(join(FUNCTIONS, name, "index.ts"));
      return CHANGED.some((changed) => [...closure].some((f) => f.endsWith(changed)));
    });
    // Every scheduled sync runs the engine. The import worker writes the
    // starter rules, whose text already said bookings, and reads none of this.
    expect(carries.sort()).toEqual(["cloudbeds-scheduled-sync", "mews-scheduled-sync", "think-scheduled-sync"]);
    for (const name of carries) expect(header).toContain(name);
  });
});
