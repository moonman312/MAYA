/**
 * The email that has to arrive before MAYA raises someone's bill.
 *
 * The correction itself is fair — they are running rooms they aren't paying for
 * — but fairness is not what stops a chargeback. Being told first is. So this
 * says the two numbers, the exact date, and the one link that makes it go away,
 * and it does not bury any of them in reassurance.
 *
 * Visual theme matches renewal-nudge-email.ts (slate-950 page, slate-900 card).
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
  warn: "#fbbf24", // amber-400
};

export type RoomShortfallInput = {
  /** The billing page, where they can set the count themselves. */
  billingUrl: string;
  /** What they are paying for today. */
  billedRooms: number;
  /** What their PMS says they run. */
  measuredRooms: number;
  /** Human date the correction lands, e.g. "6 August 2026". */
  correctionDate: string;
  /** Days left to do it themselves. Zero means the sweep is next. */
  daysLeft: number;
  /** Formatted, e.g. "$200.00" — what they pay now. */
  currentAmount: string;
  /** Formatted — what they would pay at the measured count. */
  correctedAmount: string;
  /** Bookable spaces deliberately NOT counted, so the numbers reconcile. */
  notBilledFor: string[];
};

export function roomShortfallSubject(input: RoomShortfallInput): string {
  return `Your MAYA plan covers ${input.billedRooms} rooms — your PMS shows ${input.measuredRooms}`;
}

/**
 * Reads as a correction someone can make, not an accusation. The hotel almost
 * always grew and forgot, so the tone is "your count moved" rather than "you
 * under-declared" — while still being unambiguous that the bill changes.
 */
export function roomShortfallText(input: RoomShortfallInput): string {
  const lines = [
    `Your property management system currently lists ${input.measuredRooms} guest rooms. Your MAYA plan covers ${input.billedRooms}.`,
    "",
    `MAYA is priced per room, so this changes what you pay: ${input.currentAmount} today, ${input.correctedAmount} at ${input.measuredRooms} rooms.`,
    "",
    input.daysLeft > 0
      ? `You have ${input.daysLeft} day${input.daysLeft === 1 ? "" : "s"} to set the number yourself. If it's still different on ${input.correctionDate} we'll update it to ${input.measuredRooms} and adjust your next invoice — nothing is charged today, and nothing is charged separately.`
      : `We'll update it to ${input.measuredRooms} shortly and adjust your next invoice. Nothing is charged separately.`,
    "",
    `Set your room count: ${input.billingUrl}`,
  ];

  if (input.notBilledFor.length > 0) {
    lines.push(
      "",
      `For what it's worth, we are NOT counting these, because nobody sleeps in them: ${input.notBilledFor.join(", ")}. If one of those is actually a guest room, reply and we'll include it.`,
    );
  }

  lines.push("", "If this number is wrong, change it on that page and we'll bill what you set.", "", "— MAYA");
  return lines.join("\n");
}

export function roomShortfallHtml(input: RoomShortfallInput): string {
  const deadline =
    input.daysLeft > 0
      ? `You have <strong style="color:${COLORS.heading}">${input.daysLeft} day${input.daysLeft === 1 ? "" : "s"}</strong> to set the number yourself. If it's still different on <strong style="color:${COLORS.heading}">${input.correctionDate}</strong> we'll update it to ${input.measuredRooms} and adjust your next invoice — nothing is charged today, and nothing is charged separately.`
      : `We'll update it to <strong style="color:${COLORS.heading}">${input.measuredRooms}</strong> shortly and adjust your next invoice. Nothing is charged separately.`;

  const excluded =
    input.notBilledFor.length > 0
      ? `<p style="margin:16px 0 0;color:${COLORS.muted};font-size:13px;line-height:20px">
           We are <strong>not</strong> counting these, because nobody sleeps in them:
           ${escapeHtml(input.notBilledFor.join(", "))}. If one of those is actually a guest room, reply and we'll include it.
         </p>`
      : "";

  return `<!doctype html>
<html>
<body style="margin:0;padding:24px;background:${COLORS.page};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto">
    <tr><td style="background:${COLORS.card};border:1px solid ${COLORS.border};border-radius:12px;padding:28px">
      <h1 style="margin:0 0 16px;color:${COLORS.heading};font-size:20px;line-height:28px">
        Your room count has changed
      </h1>
      <p style="margin:0;color:${COLORS.body};font-size:15px;line-height:23px">
        Your property management system currently lists
        <strong style="color:${COLORS.warn}">${input.measuredRooms} guest rooms</strong>.
        Your MAYA plan covers <strong style="color:${COLORS.heading}">${input.billedRooms}</strong>.
      </p>
      <p style="margin:16px 0 0;color:${COLORS.body};font-size:15px;line-height:23px">
        MAYA is priced per room, so this changes what you pay:
        <strong style="color:${COLORS.heading}">${escapeHtml(input.currentAmount)}</strong> today,
        <strong style="color:${COLORS.heading}">${escapeHtml(input.correctedAmount)}</strong> at ${input.measuredRooms} rooms.
      </p>
      <p style="margin:16px 0 0;color:${COLORS.body};font-size:15px;line-height:23px">${deadline}</p>
      <p style="margin:24px 0 0">
        <a href="${escapeHtml(input.billingUrl)}"
           style="display:inline-block;background:${COLORS.cta};color:${COLORS.ctaText};text-decoration:none;padding:12px 20px;border-radius:8px;font-size:15px;font-weight:600">
          Set your room count
        </a>
      </p>
      ${excluded}
      <p style="margin:20px 0 0;color:${COLORS.muted};font-size:13px;line-height:20px">
        If this number is wrong, change it on that page and we'll bill what you set.
      </p>
    </td></tr>
  </table>
</body>
</html>`;
}

/** Room type names come from the PMS, so they are somebody else's free text. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
