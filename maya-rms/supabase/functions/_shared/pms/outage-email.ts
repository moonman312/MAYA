import { emailBrandHeader } from "../email/brand.ts";

/**
 * The email a General Manager and Hotel Admin get once a property's PMS
 * connection has been down about an hour (G57). Plain on purpose: what
 * happened, what it means for their prices, and the one thing to do, in that
 * order, with the PMS tab one click away.
 *
 * Visual theme matches the app's other emails (slate-950 page, slate-900
 * card, sky button).
 */

const COLORS = {
  page: "#020617",
  card: "#0f172a",
  border: "#1e293b",
  heading: "#f1f5f9",
  body: "#cbd5e1",
  muted: "#94a3b8",
  cta: "#0ea5e9",
  ctaText: "#ffffff",
};

export type OutagePms = "cloudbeds" | "think" | "mews";

export type OutageEmailInput = {
  hotelName: string;
  pmsType: OutagePms;
  /** The connection's status when the email goes out. */
  status: "disconnected" | "error";
  /** When it went down, in the property's time, e.g. "14:05 on Tuesday, October 6". */
  downSince: string;
  /**
   * Prices were going out to the PMS before this: the property is live on a
   * system MAYA sends to. Otherwise nothing was being sent anyway, and saying
   * "no prices are sent" would read as news.
   */
  sending: boolean;
  /** Opens the PMS tab for this property. */
  pmsTabUrl: string;
};

/** The system's name as the docs write it. */
const PMS_NAME: Record<OutagePms, string> = {
  cloudbeds: "Cloudbeds",
  think: "ThinkReservations",
  mews: "Mews",
};

/** The button label exactly as the PMS tab shows it. */
const RECONNECT_LABEL: Record<OutagePms, string | null> = {
  cloudbeds: "Reconnect Cloudbeds",
  think: "Reconnect Think Reservations",
  mews: null,
};

type Section = { what: string; means: string; fix: string; onPurpose: string | null };

function sections(input: OutageEmailInput): Section {
  const pms = PMS_NAME[input.pmsType];
  const label = RECONNECT_LABEL[input.pmsType];

  let what: string;
  if (input.pmsType === "mews") {
    what =
      input.status === "error"
        ? "Mews refused MAYA's keys on three reads in a row. Usually that means the keys were revoked or replaced in Mews."
        : "MAYA's Mews keys were removed.";
  } else {
    what =
      input.status === "error"
        ? `${pms} refused to renew MAYA's access.`
        : `${pms} stopped accepting MAYA's connection. Usually that means the MAYA app was uninstalled or disconnected in ${pms}.`;
  }

  const means = input.sending
    ? `Until it is reconnected, MAYA can't read your bookings, your prices aren't updating, and no prices are sent to ${pms}. The rates already in ${pms} stay exactly as they are.`
    : `Until it is reconnected, MAYA can't read your bookings, so your prices aren't updating. Nothing in ${pms} changes.`;

  const fix = label
    ? `Open the PMS tab in MAYA and click ${label}, then sign in at ${pms} with a login for ${input.hotelName} only. The button shows for General Managers and Hotel Admins. Your rules, history and settings are all untouched.`
    : "Mews connects with keys, so this can't be fixed from inside MAYA. Reply to this email and we'll arrange new keys with you. Leave the keys themselves out of your reply: we set up a secure way to share them.";

  const onPurpose =
    input.status === "disconnected" ? "If you disconnected MAYA on purpose, you can ignore this email." : null;

  return { what, means, fix, onPurpose };
}

export function outageSubject(input: OutageEmailInput): string {
  return `MAYA has lost its connection to ${PMS_NAME[input.pmsType]} at ${input.hotelName}`;
}

function opening(input: OutageEmailInput): string {
  return `Your ${PMS_NAME[input.pmsType]} connection for ${input.hotelName} has been down since ${input.downSince} (property time).`;
}

function footer(input: OutageEmailInput): string {
  return `You're getting this as a General Manager or Hotel Admin of ${input.hotelName}. We send it once each time the connection goes down.`;
}

export function outageText(input: OutageEmailInput): string {
  const s = sections(input);
  const lines = [
    `MAYA has lost its connection to ${PMS_NAME[input.pmsType]}`,
    "",
    opening(input),
    "",
    s.what,
    "",
    s.means,
    "",
    s.fix,
    "",
    `Open the PMS tab: ${input.pmsTabUrl}`,
  ];
  if (s.onPurpose) lines.push("", s.onPurpose);
  lines.push("", footer(input), "", "MAYA");
  return lines.join("\n");
}

export function outageHtml(input: OutageEmailInput): string {
  const s = sections(input);
  const p = (text: string, top = 16) =>
    `<p style="margin:${top}px 0 0;color:${COLORS.body};font-size:15px;line-height:23px">${escapeHtml(text)}</p>`;
  const small = (text: string) =>
    `<p style="margin:16px 0 0;color:${COLORS.muted};font-size:13px;line-height:20px">${escapeHtml(text)}</p>`;

  return `<!doctype html>
<html>
<body style="margin:0;padding:24px;background:${COLORS.page};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto">
    <tr><td style="background:${COLORS.card};border:1px solid ${COLORS.border};border-radius:12px;padding:28px">
      ${emailBrandHeader(input.pmsTabUrl)}
      <h1 style="margin:0 0 16px;color:${COLORS.heading};font-size:20px;line-height:28px">
        MAYA has lost its connection to ${escapeHtml(PMS_NAME[input.pmsType])}
      </h1>
      ${p(opening(input), 0)}
      ${p(s.what)}
      ${p(s.means)}
      ${p(s.fix)}
      <p style="margin:24px 0 0">
        <a href="${escapeHtml(input.pmsTabUrl)}"
           style="display:inline-block;background:${COLORS.cta};color:${COLORS.ctaText};text-decoration:none;padding:12px 20px;border-radius:8px;font-size:15px;font-weight:600">
          Open the PMS tab
        </a>
      </p>
      ${s.onPurpose ? small(s.onPurpose) : ""}
      ${small(footer(input))}
    </td></tr>
  </table>
</body>
</html>`;
}

/** Hotel names are the owner's free text. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
