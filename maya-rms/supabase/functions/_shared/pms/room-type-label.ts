/**
 * The name MAYA shows for a room type: its full name in the property system.
 *
 * `name` first. Every sync writes the PMS's full name there, and Think and
 * Mews write the same into display_name. Cloudbeds used to put its short code
 * (roomTypeNameShort) into display_name, and two different types can share a
 * code: a property with "Harbour Double" and "Harbour Double Deluxe" read "DBL"
 * for both wherever display_name came first. display_name is only a fallback
 * for a row with no name.
 */
export function roomTypeLabel(rt: { name?: unknown; display_name?: unknown } | null | undefined): string {
  if (!rt) return "";
  for (const v of [rt.name, rt.display_name]) {
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}

/**
 * Every name the room type carries, for the name tests that decide whether
 * it is a bedroom (room-type-names.ts): PMSes differ in which one holds the
 * telling word, and "Parking" in either is enough. Never for display.
 */
export function roomTypeNames(rt: { name?: unknown; display_name?: unknown } | null | undefined): string[] {
  if (!rt) return [];
  const out: string[] = [];
  for (const v of [rt.name, rt.display_name]) {
    if (typeof v === "string" && v.trim() && !out.includes(v)) out.push(v);
  }
  return out;
}
