/**
 * explain.ts runs in the browser (the "Show the numbers" panel and the docs'
 * booking speed playground). It quotes two of the comparable-date search's
 * numbers, and must get them without bundling the search itself, the
 * season detection and the holiday calendar.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "..");

function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? join(SRC, spec.slice(2)) : spec.startsWith(".") ? join(dirname(from), spec) : null;
  if (!base) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate) && candidate.match(/\.tsx?$/)) return normalize(candidate);
  }
  return null;
}

/** Every file of ours a module pulls in, type-only imports left out. */
function importClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [normalize(entry)];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const m of source.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gm)) {
      const next = resolveImport(file, m[1]);
      if (next) stack.push(next);
    }
  }
  return seen;
}

describe("what explain.ts brings into the browser", () => {
  it("leaves out the comparable-date search, seasons and the calendar", () => {
    const closure = [...importClosure(join(SRC, "lib/explain.ts"))].map((f) => f.slice(resolve(SRC, "..").length + 1));
    const heavy = closure.filter((f) => /observations\/(comparable-dates|seasons|calendar)\.ts$/.test(f));
    expect(heavy).toEqual([]);
    expect(closure.some((f) => f.endsWith("observations/comparable-tunables.ts"))).toBe(true);
  });
});
