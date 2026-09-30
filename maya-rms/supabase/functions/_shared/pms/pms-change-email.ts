import { emailBrandHeader } from "../email/brand.ts";

/**
 * The two emails about rates changed in the property system (Jake,
 * 2026-09-30), to a property's General Manager and Hotel Admins:
 *
 *   - the overwrites: the property's setting is "MAYA's price wins", and
 *     rates MAYA sent were changed or removed in the PMS, so MAYA sent its
 *     price again. At most one a day, listing that day's nights.
 *   - the warning: the setting is "Keep the change as your price", and the
 *     changes look like another pricing tool at work. At most one a week.
 *
 * Plain on purpose, in the same look as the app's other emails (slate-950
 * page, slate-900 card, sky button): what happened, what it means, the one
 * thing to do, with the place to do it one click away.
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

/** The systems MAYA reads changes from, as the docs write them. */
export type ChangePms = "cloudbeds" | "think";

const PMS_NAME: Record<ChangePms, string> = {
  cloudbeds: "Cloudbeds",
  think: "ThinkReservations",
};

export function changePmsName(pms: string): string {
  return PMS_NAME[pms as ChangePms] ?? pms;
}

/** The property's currency as the app writes it (changelog-route-helpers currencySymbolFor). */
export function emailCurrencySymbol(code: string | null | undefined): string {
  switch (code) {
    case "USD":
      return "$";
    case "EUR":
      return "€";
    case "GBP":
      return "£";
    default:
      return code ? `${code} ` : "$";
  }
}

/** Lines the overwrite email lists before it points to the change log for the rest. */
export const MAX_DIGEST_LINES = 40;

export type OverwriteLine = {
  /** The night, as "Fri, Nov 13". */
  night: string;
  roomType: string;
  /** The PMS's rate, formatted, or null when it was removed. */
  theirs: string | null;
  /** MAYA's price, formatted. */
  maya: string;
  /** How many times that day MAYA sent its price again to this night and room type. */
  times: number;
};

export type OverwriteEmailInput = {
  hotelName: string;
  pmsType: ChangePms;
  /** When the changes were found, as "on Monday, October 5" or "between Saturday, October 3 and Monday, October 5". */
  when: string;
  /** Nearest night first; only the first MAX_DIGEST_LINES are listed. */
  lines: OverwriteLine[];
  /** Opens the calendar (of the property they last had open, for a click from an inbox). */
  calendarUrl: string;
  /** The reader can open other properties too; see outage-email.ts. */
  otherProperties?: boolean;
};

export type OtherToolEmailInput = {
  hotelName: string;
  pmsType: ChangePms;
  /** Rates changed on nights MAYA sent to, over the last 7 days. */
  rates: number;
  /** Opens Settings at the property system's section. */
  settingsUrl: string;
  otherProperties?: boolean;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function pickLine(hotelName: string, where: string): string {
  return `You look after more than one property in MAYA. If ${where} opens on another one, pick ${hotelName} in the Property dropdown.`;
}

/* ── The overwrites ───────────────────────────────────────────────────── */

export function overwriteSubject(input: OverwriteEmailInput): string {
  return `MAYA overwrote rate changes in ${PMS_NAME[input.pmsType]} at ${input.hotelName}`;
}

function overwriteOpening(input: OverwriteEmailInput): string {
  const pms = PMS_NAME[input.pmsType];
  return (
    `${input.when[0].toUpperCase()}${input.when.slice(1)}, rates in ${pms} were changed or removed on nights MAYA had sent a price to ` +
    `at ${input.hotelName}. Your setting is "MAYA's price wins", so MAYA overwrote each change again with its own price.`
  );
}

function overwriteHowTo(input: OverwriteEmailInput): string {
  return `To set a price by hand, set it in MAYA's calendar, not in ${PMS_NAME[input.pmsType]}.`;
}

function overwriteMore(input: OverwriteEmailInput): string | null {
  const more = input.lines.length - MAX_DIGEST_LINES;
  return more > 0 ? `And ${plural(more, "more night")}. The Change Log in MAYA lists every one.` : null;
}

function overwriteFooter(input: OverwriteEmailInput): string {
  return `You're getting this as a General Manager or Hotel Admin of ${input.hotelName}. MAYA sends it at most once a day, on a day it has overwritten a change.`;
}

function lineText(line: OverwriteLine, pms: string): string {
  const theirs = line.theirs == null ? `removed in ${pms}` : `${pms} ${line.theirs}`;
  const times = line.times > 1 ? ` (${line.times} times)` : "";
  return `${line.night}, ${line.roomType}: ${theirs}, MAYA's price ${line.maya}${times}`;
}

export function overwriteText(input: OverwriteEmailInput): string {
  const pms = PMS_NAME[input.pmsType];
  const more = overwriteMore(input);
  const lines = [
    `MAYA overwrote rate changes in ${pms}`,
    "",
    overwriteOpening(input),
    "",
    ...input.lines.slice(0, MAX_DIGEST_LINES).map((l) => `- ${lineText(l, pms)}`),
    ...(more ? ["", more] : []),
    "",
    overwriteHowTo(input),
    ...(input.otherProperties ? ["", pickLine(input.hotelName, "the calendar")] : []),
    "",
    `Open the calendar: ${input.calendarUrl}`,
    "",
    overwriteFooter(input),
    "",
    "MAYA",
  ];
  return lines.join("\n");
}

export function overwriteHtml(input: OverwriteEmailInput): string {
  const pms = PMS_NAME[input.pmsType];
  const more = overwriteMore(input);
  const cell = (text: string, align: "left" | "right" = "left", color = COLORS.body) =>
    `<td style="padding:6px 8px;border-top:1px solid ${COLORS.border};color:${color};font-size:14px;line-height:20px;text-align:${align}">${escapeHtml(text)}</td>`;
  const head = (text: string, align: "left" | "right" = "left") =>
    `<th style="padding:0 8px 6px;color:${COLORS.muted};font-size:12px;font-weight:600;text-align:${align}">${escapeHtml(text)}</th>`;
  const rows = input.lines
    .slice(0, MAX_DIGEST_LINES)
    .map(
      (l) =>
        `<tr>${cell(l.night)}${cell(l.roomType)}${cell(l.theirs ?? "Removed", "right", l.theirs == null ? COLORS.muted : COLORS.body)}${cell(
          l.times > 1 ? `${l.maya} (${l.times} times)` : l.maya,
          "right",
        )}</tr>`,
    )
    .join("");
  return page(
    input.calendarUrl,
    `MAYA overwrote rate changes in ${pms}`,
    [
      p(overwriteOpening(input), 0),
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0 0;border-collapse:collapse">
        <tr>${head("Night")}${head("Room type")}${head(pms, "right")}${head("MAYA's price", "right")}</tr>
        ${rows}
      </table>`,
      more ? small(more) : "",
      p(overwriteHowTo(input)),
      input.otherProperties ? p(pickLine(input.hotelName, "the calendar")) : "",
      button(input.calendarUrl, "Open the calendar"),
      small(overwriteFooter(input)),
    ],
  );
}

/* ── The warning ─────────────────────────────────────────────────────── */

export function otherToolSubject(input: OtherToolEmailInput): string {
  return `Something other than MAYA seems to be changing rates in ${PMS_NAME[input.pmsType]} at ${input.hotelName}`;
}

function otherToolSections(input: OtherToolEmailInput): { what: string; means: string; fix: string; yours: string } {
  const pms = PMS_NAME[input.pmsType];
  return {
    what:
      `In the last 7 days, ${plural(input.rates, "rate")} in ${pms} ${input.rates === 1 ? "was" : "were"} changed on nights MAYA had sent a price to ` +
      `at ${input.hotelName}. That looks like something other than MAYA, such as another pricing tool, is changing them.`,
    means: "Your setting keeps each change as your price, so MAYA isn't pricing those nights.",
    fix: `If you use another pricing tool, turn on "MAYA's price wins" in Settings. MAYA then sends its own price again whenever a rate it sent is changed in ${pms}.`,
    yours: "If you made these changes yourself, there is nothing to do.",
  };
}

function otherToolFooter(input: OtherToolEmailInput): string {
  return `You're getting this as a General Manager or Hotel Admin of ${input.hotelName}. MAYA sends it at most once a week.`;
}

export function otherToolText(input: OtherToolEmailInput): string {
  const s = otherToolSections(input);
  return [
    `Something other than MAYA seems to be changing rates in ${PMS_NAME[input.pmsType]}`,
    "",
    s.what,
    "",
    s.means,
    "",
    s.fix,
    ...(input.otherProperties ? ["", pickLine(input.hotelName, "Settings")] : []),
    "",
    `Open Settings: ${input.settingsUrl}`,
    "",
    s.yours,
    "",
    otherToolFooter(input),
    "",
    "MAYA",
  ].join("\n");
}

export function otherToolHtml(input: OtherToolEmailInput): string {
  const s = otherToolSections(input);
  return page(
    input.settingsUrl,
    `Something other than MAYA seems to be changing rates in ${PMS_NAME[input.pmsType]}`,
    [
      p(s.what, 0),
      p(s.means),
      p(s.fix),
      input.otherProperties ? p(pickLine(input.hotelName, "Settings")) : "",
      button(input.settingsUrl, "Open Settings"),
      small(s.yours),
      small(otherToolFooter(input)),
    ],
  );
}

/* ── Shared pieces ───────────────────────────────────────────────────── */

function p(text: string, top = 16): string {
  return `<p style="margin:${top}px 0 0;color:${COLORS.body};font-size:15px;line-height:23px">${escapeHtml(text)}</p>`;
}

function small(text: string): string {
  return `<p style="margin:16px 0 0;color:${COLORS.muted};font-size:13px;line-height:20px">${escapeHtml(text)}</p>`;
}

function button(url: string, label: string): string {
  return `<p style="margin:24px 0 0">
        <a href="${escapeHtml(url)}"
           style="display:inline-block;background:${COLORS.cta};color:${COLORS.ctaText};text-decoration:none;padding:12px 20px;border-radius:8px;font-size:15px;font-weight:600">
          ${escapeHtml(label)}
        </a>
      </p>`;
}

function page(baseUrl: string, heading: string, parts: string[]): string {
  return `<!doctype html>
<html>
<body style="margin:0;padding:24px;background:${COLORS.page};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto">
    <tr><td style="background:${COLORS.card};border:1px solid ${COLORS.border};border-radius:12px;padding:28px">
      ${emailBrandHeader(baseUrl)}
      <h1 style="margin:0 0 16px;color:${COLORS.heading};font-size:20px;line-height:28px">
        ${escapeHtml(heading)}
      </h1>
      ${parts.filter(Boolean).join("\n      ")}
    </td></tr>
  </table>
</body>
</html>`;
}

/** Hotel and room type names are the owner's free text. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
