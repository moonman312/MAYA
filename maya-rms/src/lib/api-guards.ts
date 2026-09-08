/**
 * Input guards and error shaping shared by the explain/challenges routes.
 *
 * Malformed input gets a 400 before it ever reaches Postgres, permission
 * failures surface as a plain-language 403 instead of raw RLS text, and
 * anything else becomes a generic 500 — internal error strings stay out of
 * owner-facing responses.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** True only for a real calendar date — "2026-02-30" and "2026-13-01" fail. */
export function isRealIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
  );
}

/** Postgres error code carried by supabase-js errors, when present. */
function pgCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

/**
 * Owner-safe status + message for a failed Supabase write/read. Insufficient
 * RLS rights read as a permissions problem, not database jargon.
 */
export function dbErrorResponse(error: unknown): { status: number; message: string } {
  if (pgCode(error) === "42501") {
    return { status: 403, message: "You need manager access to do that." };
  }
  return { status: 500, message: "Something went wrong on our side. Try again in a moment." };
}
