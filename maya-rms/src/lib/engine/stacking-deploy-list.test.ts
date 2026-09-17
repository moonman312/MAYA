/**
 * The migration's deploy runbook names every edge function that carries the
 * code this build changed.
 *
 * There is no pre-migration path: the migration runs, then the functions go
 * out, then the app. A function left on the old bundle keeps doing the old
 * thing. onboarding-import-worker was missing from the list although it is the
 * only place that writes a hotel's starter rules and the explanations that now
 * say a rule adjusts again and that MAYA asks after three times
 * (_shared/onboarding/generate-rules.ts through analysis.ts) -- and a hotel
 * onboarded on the old bundle keeps that text for good.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const FUNCTIONS = resolve(__dirname, "../../../supabase/functions");
const MIGRATION = resolve(__dirname, "../../../../99_supabase_migration_pickup_event_stacking_v1.sql");

/** Shared modules this build changed the behaviour of. */
const CHANGED = [
  "supabase/functions/_shared/engine/pickup.ts",
  "supabase/functions/_shared/engine/evaluate.ts",
  "supabase/functions/_shared/engine/pricing.ts",
  "supabase/functions/_shared/engine/repeat-alerts.ts",
  "supabase/functions/_shared/pms/manual-price.ts",
  "supabase/functions/_shared/onboarding/generate-rules.ts",
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

describe("the pickup event stacking migration's deploy list", () => {
  it("names every function whose bundle carries code this build changed", () => {
    const header = readFileSync(MIGRATION, "utf8").slice(0, 8000);
    const names = readdirSync(FUNCTIONS, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== "_shared")
      .map((d) => d.name);
    expect(names.length).toBeGreaterThan(0);

    const carries = names.filter((name) => {
      const closure = importClosure(join(FUNCTIONS, name, "index.ts"));
      return CHANGED.some((changed) => [...closure].some((f) => f.endsWith(changed)));
    });
    // Every scheduled sync runs the engine; the import worker writes the
    // starter rules and their explanations.
    expect(carries.sort()).toEqual([
      "cloudbeds-scheduled-sync",
      "mews-scheduled-sync",
      "onboarding-import-worker",
      "think-scheduled-sync",
    ]);
    for (const name of carries) expect(header).toContain(name);
  });
});
