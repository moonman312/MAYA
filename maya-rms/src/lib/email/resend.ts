import "server-only";

/**
 * Minimal Resend client (https://resend.com/docs/api-reference/emails/send-email).
 *
 * Deliberately fetch-based — no SDK dependency, works in both the Node and
 * Edge runtimes. Swap for the official `resend` npm package later if we start
 * needing attachments, batch sends, or audiences.
 *
 * Env required:
 *   - RESEND_API_KEY        (server-only; never prefix with NEXT_PUBLIC_)
 *   - RESEND_FROM_EMAIL     e.g. `MAYA <invites@yourdomain.com>` — the domain
 *                           must be verified in the Resend dashboard.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";

const MAX_ATTEMPTS = 3;

/**
 * Ceiling on any one wait. Callers include webhook handlers holding a request
 * open, so honouring an arbitrarily large Retry-After would trade one dropped
 * email for a timed-out webhook.
 */
const MAX_WAIT_MS = 5_000;

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
  return Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL);
}

export type SendEmailInput = {
  to: string;
  subject: string;
  html: string;
  /** Plain-text alternative. Always provide one — improves deliverability. */
  text: string;
  replyTo?: string;
  /**
   * Resend collapses repeat sends carrying the same key (24h window). Set it for
   * anything a webhook can trigger: Stripe redelivers, and the second delivery
   * would otherwise mail the same person the same thing again.
   */
  idempotencyKey?: string;
};

/**
 * Sends a single transactional email through Resend.
 * Throws with a readable message on any configuration or API failure so
 * callers can surface it in the admin UI (same contract the Supabase
 * invite errors had).
 */
export async function sendEmail(input: SendEmailInput): Promise<{ id: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) {
    throw new Error(
      "Resend is not configured. Set RESEND_API_KEY and RESEND_FROM_EMAIL in .env.local (dev) and Vercel env (prod).",
    );
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
    });

    // Only a 429 gets retried — Resend meters per second, so the wait is short
    // and the same request a moment later genuinely can succeed. Anything else
    // failing (bad domain, malformed payload) fails identically on a retry.
    // Repeating the POST is safe for the callers that matter: the ones a
    // webhook can trigger already carry an Idempotency-Key.
    if (res.status === 429 && attempt < MAX_ATTEMPTS - 1) {
      const waitMs = Math.min(parseRetryAfterMs(res) ?? backoffMs, MAX_WAIT_MS);
      backoffMs *= 2;
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { message?: string; name?: string };
        if (body.message) detail = `${detail} — ${body.message}`;
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
