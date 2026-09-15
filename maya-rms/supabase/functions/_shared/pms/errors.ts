/**
 * Errors a PMS adapter raises that the onboarding flow wants to name on
 * screen, rather than pass through as the adapter's own words.
 *
 * Plain classes with no imports: this is shared by the Deno edge functions
 * and the Next app, and both sides construct and instanceof-check it.
 */

/**
 * One login, several properties. A group account's grant covers every
 * property in the group, and there is no honest way to pick one — binding a
 * MAYA hotel to an arbitrary sibling is how rates get pushed to the wrong
 * property. The adapter refuses; the flow explains.
 */
export class AmbiguousGroupGrantError extends Error {
  constructor(
    public readonly count: number,
    public readonly pms: string,
  ) {
    super(`${pms}: this login covers ${count} properties.`);
    this.name = "AmbiguousGroupGrantError";
  }
}

/**
 * Not instanceof alone: module identity can differ between the Deno bundle
 * and the Node build when the same file is reached by two import paths.
 */
export function isAmbiguousGroupGrant(e: unknown): e is AmbiguousGroupGrantError {
  return (
    e instanceof AmbiguousGroupGrantError ||
    (e instanceof Error &&
      e.name === "AmbiguousGroupGrantError" &&
      typeof (e as { count?: unknown }).count === "number" &&
      typeof (e as { pms?: unknown }).pms === "string")
  );
}
