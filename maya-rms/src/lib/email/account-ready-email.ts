import "server-only";
import { emailBrandHeader } from "./brand";

/**
 * The email that keeps the promise on the "Payment received" screen: leave the
 * page, and we'll email you when your account is ready.
 *
 * Short on purpose. Someone who walked away from a spinner wants to know two
 * things: that it worked, and what to do next. So it says that, gives the one
 * link that picks up wherever they are, and stops. A trial reads differently
 * from a paid start because "your payment went through" would be untrue on a
 * card that has not been charged.
 *
 * Replies go to a person (ACCOUNT_READY_REPLY_TO), which is why the copy can
 * invite one.
 *
 * Visual theme matches renewal-nudge-email.ts (slate-950 page, slate-900 card).
 */

export const ACCOUNT_READY_REPLY_TO = "info@modern-hospitality-solutions.com";

const COLORS = {
  page: "#020617", // slate-950
  card: "#0f172a", // slate-900
  border: "#1e293b", // slate-800
  heading: "#f1f5f9", // slate-100
  body: "#cbd5e1", // slate-300
  muted: "#94a3b8", // slate-400
  cta: "#0ea5e9", // sky-500
  ctaText: "#ffffff",
};

export type AccountReadyInput = {
  /** /onboarding on this deployment: it resolves whichever step they are on. */
  continueUrl: string;
  /** The property's name once the PMS gave it one; null before that. */
  propertyName: string | null;
  /** Human date the trial ends, e.g. "October 6, 2026"; null when not on a trial. */
  trialEndsOn: string | null;
  /**
   * Already connected to the PMS (a Cloudbeds Marketplace arrival), so the
   * history is being read; otherwise connecting is the next step.
   */
  pmsConnected: boolean;
};

export function accountReadySubject(input: AccountReadyInput): string {
  return input.propertyName ? `${input.propertyName} is ready in MAYA` : "Your MAYA account is ready";
}

function lines(input: AccountReadyInput): { opening: string; money: string; next: string; mews: string | null } {
  return {
    opening: input.propertyName
      ? `Thanks for signing up. ${input.propertyName} is set up in MAYA and ready for you.`
      : "Thanks for signing up. Your MAYA account is set up and ready for you.",
    money: input.trialEndsOn
      ? `Your card is saved and your free trial runs until ${input.trialEndsOn}. Nothing is charged before then.`
      : "Your subscription has started.",
    next: input.pmsConnected
      ? "Your property system is connected and MAYA has started reading your booking history. Your next step is waiting for you."
      : "Your next step is to connect your property management system. Once it's connected, MAYA reads your booking history.",
    // Mews is connected by us, not from the connect screen, so the one person
    // who cannot follow the line above is told what to do instead.
    mews: input.pmsConnected ? null : "If you use Mews, reply to this email and we'll connect it with you.",
  };
}

const SIMULATION =
  "Every property starts in simulation, so nothing is sent to your system until you choose to go live.";

export function accountReadyText(input: AccountReadyInput): string {
  const l = lines(input);
  return [
    l.opening,
    "",
    l.money,
    "",
    l.next,
    ...(l.mews ? ["", l.mews] : []),
    "",
    `Pick up where you left off: ${input.continueUrl}`,
    "",
    SIMULATION,
    "",
    "Questions? Just reply to this email.",
    "",
    "The MAYA team",
  ].join("\n");
}

export function accountReadyHtml(input: AccountReadyInput): string {
  const l = lines(input);
  const p = (text: string, margin = "0 0 16px") =>
    `<p style="margin:${margin};font-size:15px;line-height:1.6;color:${COLORS.body};">${escapeHtml(text)}</p>`;

  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:${COLORS.page};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;">
      <tr>
        <td style="background:${COLORS.card};border:1px solid ${COLORS.border};border-radius:12px;padding:28px;">
          ${emailBrandHeader(input.continueUrl)}
          <h1 style="margin:0 0 16px;font-size:20px;line-height:28px;color:${COLORS.heading};">Your account is ready</h1>
          ${p(l.opening)}
          ${p(l.money)}
          ${p(l.next)}
          ${l.mews ? p(l.mews) : ""}
          <p style="margin:8px 0 24px;">
            <a href="${escapeHtml(input.continueUrl)}"
               style="display:inline-block;background:${COLORS.cta};color:${COLORS.ctaText};text-decoration:none;font-size:14px;font-weight:600;padding:11px 22px;border-radius:6px;">
              Pick up where you left off
            </a>
          </p>
          <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:${COLORS.muted};">${escapeHtml(SIMULATION)}</p>
          <p style="margin:0;font-size:13px;line-height:1.6;color:${COLORS.muted};">Questions? Just reply to this email.</p>
        </td>
      </tr>
      <tr>
        <td style="padding:16px 4px 0;font-size:11px;color:${COLORS.muted};">MAYA &middot; Machine Assisted Yield Automation</td>
      </tr>
    </table>
  </body>
</html>`;
}

/** The property name comes from the PMS, so it is somebody else's free text. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
