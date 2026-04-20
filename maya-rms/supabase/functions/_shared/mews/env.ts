/** Works in Deno (Edge) and Node (Next.js). */
export function mwsEnv(name: string): string | undefined {
  // Deno Deploy / Edge
  const d = (globalThis as { Deno?: { env?: { get: (k: string) => string | undefined } } }).Deno;
  if (d?.env?.get) {
    const v = d.env.get(name);
    if (v !== undefined && v !== "") return v;
  }
  if (typeof process !== "undefined" && process.env) {
    const v = process.env[name];
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}
