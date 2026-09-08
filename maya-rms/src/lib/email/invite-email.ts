import "server-only";
import type { HotelRole } from "@/lib/admin/types";
import { roleLabel as roleLabelFor } from "@/lib/roles";

/**
 * MAYA invite email, rendered server-side and sent through Resend.
 *
 * Replaces the Supabase Auth "Invite user" template. The copy mirrors
 * Supabase's default ("You have been invited") and the personalization the
 * old template metadata carried (hotel name, role, inviter email). The
 * visual theme mirrors the app's accept-invite page: slate-950 backdrop,
 * slate-900 card with a slate-800 border, and the sky-500 CTA button.
 */

// Tailwind slate/sky values used across the app (globals + accept-invite page).
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

export type InviteEmailInput = {
  acceptUrl: string;
  hotelName: string;
  role: HotelRole;
  inviterEmail: string | null;
  /** True when this is a re-send of an existing pending invite. */
  isResend?: boolean;
};

export function inviteEmailSubject(input: InviteEmailInput): string {
  return `You have been invited to ${input.hotelName} on MAYA`;
}

export function inviteEmailText(input: InviteEmailInput): string {
  const roleLabel = roleLabelFor(input.role);
  const inviterLine = input.inviterEmail
    ? `${input.inviterEmail} has invited you`
    : "You have been invited";
  return [
    `${inviterLine} to join ${input.hotelName} on MAYA as ${roleLabel}.`,
    "",
    "Follow this link to accept the invite and set your password:",
    input.acceptUrl,
    "",
    "This link is single-use and expires after a limited time. If it has expired, ask an administrator to resend the invite.",
    "",
    "If you weren't expecting this invitation, you can safely ignore this email.",
  ].join("\n");
}

export function inviteEmailHtml(input: InviteEmailInput): string {
  const roleLabel = roleLabelFor(input.role);
  const hotelName = escapeHtml(input.hotelName);
  const inviterLine = input.inviterEmail
    ? `<strong style="color:${COLORS.heading};">${escapeHtml(input.inviterEmail)}</strong> has invited you`
    : "You have been invited";

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark" />
    <meta name="supported-color-schemes" content="dark" />
    <title>${escapeHtml(inviteEmailSubject(input))}</title>
  </head>
  <body style="margin:0;padding:0;background-color:${COLORS.page};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${COLORS.page};padding:24px 0;">
      <tr>
        <td align="center" style="padding:24px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:448px;background-color:${COLORS.card};border:1px solid ${COLORS.border};border-radius:8px;">
            <tr>
              <td style="padding:24px;">
                <p style="margin:0 0 16px;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:${COLORS.muted};">MAYA</p>
                <h1 style="margin:0 0 12px;font-size:24px;font-weight:600;color:${COLORS.heading};">You're invited</h1>
                <p style="margin:0 0 8px;font-size:14px;line-height:1.6;color:${COLORS.body};">
                  ${inviterLine} to join
                  <strong style="color:${COLORS.heading};">${hotelName}</strong>
                  on MAYA as <strong style="color:${COLORS.heading};">${escapeHtml(roleLabel)}</strong>.
                </p>
                <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:${COLORS.body};">
                  Follow the link below to accept the invite and set your password.
                </p>
                <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                  <tr>
                    <td align="center">
                      <a href="${escapeAttr(input.acceptUrl)}"
                         style="display:block;width:100%;box-sizing:border-box;background-color:${COLORS.cta};border-radius:4px;padding:10px 12px;font-size:14px;font-weight:500;color:${COLORS.ctaText};text-decoration:none;text-align:center;">
                        Accept the invite
                      </a>
                    </td>
                  </tr>
                </table>
                <p style="margin:20px 0 0;font-size:12px;line-height:1.6;color:${COLORS.muted};">
                  This link is single-use and expires after a limited time. If it has
                  expired, ask an administrator to resend the invite.
                </p>
                <p style="margin:12px 0 0;font-size:12px;line-height:1.6;color:${COLORS.muted};">
                  If the button doesn't work, copy and paste this URL into your browser:<br />
                  <a href="${escapeAttr(input.acceptUrl)}" style="color:${COLORS.cta};word-break:break-all;">${escapeHtml(input.acceptUrl)}</a>
                </p>
              </td>
            </tr>
          </table>
          <p style="margin:16px 0 0;font-size:12px;color:${COLORS.muted};">
            If you weren't expecting this invitation, you can safely ignore this email.
          </p>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}
