import "server-only";
import { emailBrandHeader } from "./brand";

/**
 * The email that goes out a few days before a charge, to a property that has
 * paid but never connected its PMS.
 *
 * Hoteliers sign up keen and then get pulled onto something else; the charge is
 * what makes them reprioritise. This lands BEFORE the money moves so the charge
 * arrives as something they acted on rather than something that happened to
 * them — which is also the difference between a customer who onboards and one
 * who opens a dispute.
 *
 * The room count is stated prominently because it is the one number they gave
 * us from memory, before any import could check it. A GM who typed 40 and
 * actually has 24 should be able to see that here and fix it while it is still
 * a correction rather than a refund.
 *
 * Visual theme matches invite-email.ts (slate-950 page, slate-900 card).
 */

const COLORS = {
  page: "#020617", // slate-950
  card: "#0f172a", // slate-900
  border: "#1e293b", // slate-800
  heading: "#f1f5f9", // slate-100
  body: "#cbd5e1", // slate-300
  muted: "#94a3b8", // slate-400
  cta: "#0ea5e9", // sky-500
  ctaText: "#ffffff",
  amount: "#f1f5f9",
};

export type RenewalNudgeInput = {
  /** Where they pick up the PMS connection. */
  resumeUrl: string;
  /**
   * Where the room count can actually be changed. Separate from resumeUrl
   * because they are different screens — and only reachable once the PMS is
   * connected, since billing bounces a never-finished property back to
   * onboarding. The copy has to sell the steps in that order or it promises a
   * page this audience cannot open.
   */
  billingUrl: string;
  /** Formatted with currency, e.g. "$132.00". */
  amount: string;
  /** Human date the charge lands, e.g. "Thursday, 6 August". */
  chargeDate: string;
  billingInterval: "month" | "year";
  /** What they told us at signup — the number they may want to correct. */
  roomCount: number;
  /** Per-room rate for that count, e.g. "$5.50". */
  perRoom: string;
  /** Set when this is the very first charge (a trial ending), which reads differently. */
  isFirstCharge: boolean;
};

/**
 * Where a reply goes. The Mews line asks for one, and a reply that landed on
 * the sending address would reach nobody.
 */
export const NUDGE_REPLY_TO = "info@modern-hospitality-solutions.com";

/**
 * Nothing here knows which system the property uses: a paid property with no
 * connection has told us nothing we kept. So the two-minute connect is not
 * promised in the subject, and the body says what a Mews property does
 * instead, since Mews is one we connect for them.
 */
export function renewalNudgeSubject(input: RenewalNudgeInput): string {
  return input.isFirstCharge
    ? `Your MAYA subscription starts ${input.chargeDate} and isn't connected to your PMS yet`
    : `MAYA renews ${input.chargeDate} and isn't connected to your PMS yet`;
}

export function renewalNudgeText(input: RenewalNudgeInput): string {
  const per = input.billingInterval === "month" ? "month" : "year";
  return [
    input.isFirstCharge
      ? `Your first MAYA payment of ${input.amount} is scheduled for ${input.chargeDate}.`
      : `Your MAYA subscription renews on ${input.chargeDate} for ${input.amount}.`,
    "",
    "MAYA isn't connected to your property management system yet, so your rules haven't been able to run. Connecting takes about two minutes, and it's the only setup step that matters: once you're connected, MAYA reads your own booking history and builds your starter rules from it.",
    "",
    `On Mews? We connect it for you. Reply to this email or write to ${NUDGE_REPLY_TO} and we'll set it up with you.`,
    "",
    `Finish setting up: ${input.resumeUrl}`,
    "",
    `What you're paying for: ${input.roomCount} rooms at ${input.perRoom} per room, per ${per}.`,
    `If ${input.roomCount} isn't right, connect first — that opens your billing page (${input.billingUrl}), where you can change it before the ${input.chargeDate} charge and we'll bill the corrected number.`,
    "",
    "— MAYA",
  ].join("\n");
}

export function renewalNudgeHtml(input: RenewalNudgeInput): string {
  const per = input.billingInterval === "month" ? "month" : "year";
  const lead = input.isFirstCharge
    ? `Your first MAYA payment of <strong style="color:${COLORS.heading}">${input.amount}</strong> is scheduled for <strong style="color:${COLORS.heading}">${input.chargeDate}</strong>.`
    : `Your MAYA subscription renews on <strong style="color:${COLORS.heading}">${input.chargeDate}</strong> for <strong style="color:${COLORS.heading}">${input.amount}</strong>.`;

  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:${COLORS.page};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;">
      <tr>
        <td style="background:${COLORS.card};border:1px solid ${COLORS.border};border-radius:12px;padding:28px;">
          ${emailBrandHeader(input.resumeUrl)}
          <p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:${COLORS.body};">${lead}</p>

          <p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:${COLORS.body};">
            MAYA isn&rsquo;t connected to your property management system yet, so your rules
            haven&rsquo;t been able to run. Connecting takes about two minutes, and it&rsquo;s
            the only setup step that matters: once you&rsquo;re connected, MAYA reads your own
            booking history and builds your starter rules from it.
          </p>

          <p style="margin:0 0 22px;font-size:15px;line-height:1.6;color:${COLORS.body};">
            On Mews? We connect it for you. Reply to this email or write to
            <a href="mailto:${NUDGE_REPLY_TO}?subject=Connect%20Mews" style="color:${COLORS.cta}">${NUDGE_REPLY_TO}</a>
            and we&rsquo;ll set it up with you.
          </p>

          <p style="margin:0 0 26px;">
            <a href="${input.resumeUrl}"
               style="display:inline-block;background:${COLORS.cta};color:${COLORS.ctaText};text-decoration:none;font-size:14px;font-weight:600;padding:11px 22px;border-radius:6px;">
              Finish setting up MAYA
            </a>
          </p>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
                 style="border-top:1px solid ${COLORS.border};padding-top:18px;">
            <tr>
              <td style="padding-top:18px;">
                <p style="margin:0 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:0.06em;color:${COLORS.muted};">
                  What you&rsquo;re paying for
                </p>
                <p style="margin:0 0 4px;font-size:20px;font-weight:600;color:${COLORS.amount};">
                  ${input.roomCount} rooms
                </p>
                <p style="margin:0 0 14px;font-size:13px;line-height:1.5;color:${COLORS.muted};">
                  ${input.perRoom} per room, per ${per} &mdash; ${input.amount} total.
                </p>
                <p style="margin:0;font-size:13px;line-height:1.6;color:${COLORS.body};">
                  If <strong style="color:${COLORS.heading}">${input.roomCount}</strong> isn&rsquo;t right,
                  connect first &mdash; that opens your
                  <a href="${input.billingUrl}" style="color:${COLORS.cta}">billing page</a>,
                  where you can change it before the ${input.chargeDate} charge and
                  we&rsquo;ll bill the corrected number.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:16px 4px 0;font-size:11px;color:${COLORS.muted};">MAYA &mdash; Machine Assisted Yield Automation</td>
      </tr>
    </table>
  </body>
</html>`;
}
