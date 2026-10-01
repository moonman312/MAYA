/**
 * The cron secret of a scheduled function, checked before anything runs.
 *
 * The scheduled syncs and the import worker run with verify_jwt = false
 * (supabase/config.toml), so pg_cron can call them, and the secret header is
 * all that stands between the public internet and a sync, a pricing run or a
 * send for any hotel id. Each function used to check the secret only when one
 * was set: a secret missing after a project rebuild or a secret change left
 * everything working, so nothing looked wrong, while anyone who knew the
 * address could start syncs, burn a property's PMS allowance and read hotel
 * ids back from the answer. A missing secret now refuses every request (503,
 * as the billing jobs do), and a wrong one is refused as before (401).
 *
 * The comparison runs over SHA-256 digests in constant time, so neither the
 * secret's length nor how much of it a guess got right shows in the timing.
 */

export type CronSecretCheck = {
  /** The function, for the log line and the answer. */
  fn: string;
  /** The secret's name in the Supabase function secrets. */
  env: string;
  /** The header the cron sends it in. */
  header: string;
  /** The secret's value, undefined or blank when not set. */
  secret: string | undefined;
};

/** A refusal to answer with, or null when the request carries the secret. */
export async function refuseWithoutCronSecret(req: Request, check: CronSecretCheck): Promise<Response | null> {
  const json = (body: Record<string, unknown>, status: number) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  if (!check.secret) {
    console.error(JSON.stringify({ fn: check.fn, step: "auth", error: `${check.env} missing`, refused: true }));
    return json(
      {
        ok: false,
        error: `${check.env} is not set for ${check.fn}, so it refuses every request. Set it in the Supabase function secrets, and the same value in the app.`,
      },
      503,
    );
  }
  if (!(await secretMatches(req.headers.get(check.header), check.secret))) {
    return json({ ok: false, error: `Invalid or missing ${check.header}.` }, 401);
  }
  return null;
}

/** Whether a presented secret is the expected one, compared in constant time. */
export async function secretMatches(presented: string | null, expected: string): Promise<boolean> {
  if (!presented || !expected) return false;
  const [a, b] = await Promise.all([digest(presented), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}
