/**
 * The lockup at the top of every MAYA email, for templates the edge functions
 * send. A copy of src/lib/email/brand.ts, which they cannot import;
 * src/lib/email/edge-email.test.ts checks the two give the same header.
 */

const LOCKUP_PATH = "/brand/maya-lockup-email.png";

export const EMAIL_LOCKUP_WIDTH = 140;
export const EMAIL_LOCKUP_HEIGHT = 45;

const MUTED = "#94a3b8"; // slate-400

/** `https://maya-rms.com` from any absolute link on the app, or null. */
export function emailImageOrigin(baseUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return parsed.origin;
}

export function emailBrandHeader(baseUrl: string): string {
  const origin = emailImageOrigin(baseUrl);
  const brand = origin
    ? `<img src="${origin}${LOCKUP_PATH}" alt="MAYA" width="${EMAIL_LOCKUP_WIDTH}" height="${EMAIL_LOCKUP_HEIGHT}" style="display:block;border:0;outline:none;text-decoration:none;height:auto;max-width:100%">`
    : `<p style="margin:0;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:${MUTED};">MAYA</p>`;

  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%">
  <tr>
    <td style="padding:0 0 20px;">${brand}</td>
  </tr>
</table>`;
}
