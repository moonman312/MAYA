/**
 * The lockup at the top of every MAYA email.
 *
 * Email clients are the one place the SVG brand set cannot go: Gmail and
 * Outlook strip inline SVG and refuse it as an image source, so the header is
 * a PNG served from the app's own public origin, with explicit width/height
 * attributes because Outlook sizes an image from those and ignores the CSS.
 *
 * The origin comes from whatever absolute link the template is already
 * sending, so the logo and the button can never point at two different
 * deployments. Anything that isn't an http(s) URL falls back to the text
 * wordmark; a broken image icon above "You're invited" is worse than no logo.
 */

const LOCKUP_PATH = "/brand/maya-lockup-email.png";

// The served PNG is 1392 x 450 (a 2x export). 140 px wide is the on-screen
// size; 45 keeps the aspect ratio, so no client has to rescale the bitmap.
export const EMAIL_LOCKUP_WIDTH = 140;
export const EMAIL_LOCKUP_HEIGHT = 45;

const MUTED = "#94a3b8"; // slate-400, same as the templates' COLORS.muted

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

/**
 * One self-contained cell to drop in as the first thing inside the card. It
 * carries its own presentation table because a bare <tr> can't sit inside the
 * card's <td>, and every template pads the card on that cell.
 */
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
