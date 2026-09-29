/**
 * Resend for the edge functions: the same client as src/lib/email/resend.ts,
 * which the scheduled syncs cannot import (they run under Deno and only see
 * supabase/functions). Keep the two in step: plain fetch, no SDK, only a 429
 * is retried, and a failure throws a readable message.
 *
 * Differences, both because this runs inside a sync's time budget rather than
 * a request: env is read from Deno.env as well as process.env, and each call
 * gives up after REQUEST_TIMEOUT_MS instead of waiting as long as Resend does.
 *
 * Secrets (Supabase, not Vercel): RESEND_API_KEY, RESEND_FROM_EMAIL.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const MAX_ATTEMPTS = 3;
const MAX_WAIT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 10_000;

function readEnv(name: string): string | undefined {
  const v =
    (typeof process !== "undefined" ? process.env?.[name] : undefined) ??
    (globalThis as { Deno?: { env?: { get(k: string): string | undefined } } }).Deno?.env?.get(name);
  return v && v !== "" ? v : undefined;
}

/** Parses Retry-After: seconds (integer) or HTTP-date. */
function parseRetryAfterMs(res: Response): number | null {
  const raw = res.headers.get("Retry-After")?.trim();
  if (!raw) return null;
  const sec = Number.parseInt(raw, 10);
  if (Number.isFinite(sec) && sec >= 0) return sec * 1000;
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function isResendConfigured(): boolean {
  return Boolean(readEnv("RESEND_API_KEY") && readEnv("RESEND_FROM_EMAIL"));
}

export type SendEmailInput = {
  to: string;
  subject: string;
  html: string;
  /** Plain-text alternative. Always provide one. */
  text: string;
  replyTo?: string;
  /** Resend collapses repeat sends carrying the same key (24h window). */
  idempotencyKey?: string;
};

export async function sendEmail(input: SendEmailInput): Promise<{ id: string }> {
  const apiKey = readEnv("RESEND_API_KEY");
  const from = readEnv("RESEND_FROM_EMAIL");
  if (!apiKey || !from) {
    throw new Error("Resend is not configured. Set the RESEND_API_KEY and RESEND_FROM_EMAIL Supabase secrets.");
  }

  let backoffMs = 1_000;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        from,
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
        ...(input.replyTo ? { reply_to: input.replyTo } : {}),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (res.status === 429 && attempt < MAX_ATTEMPTS - 1) {
      const waitMs = Math.min(parseRetryAfterMs(res) ?? backoffMs, MAX_WAIT_MS);
      backoffMs *= 2;
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { message?: string };
        if (body.message) detail = `${detail}: ${body.message}`;
      } catch {
        // Non-JSON error body; keep the status code.
      }
      throw new Error(`Resend send failed: ${detail}`);
    }

    const body = (await res.json()) as { id: string };
    return { id: body.id };
  }

  throw new Error("Resend send failed: retry loop fell through");
}
