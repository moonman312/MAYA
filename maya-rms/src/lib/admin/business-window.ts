/**
 * The windows a property's business numbers are shown for on its Command
 * Center page, counted in the hotel's own days. Each fits in one
 * staff_hotel_business_numbers() call (401 nights at most).
 */

export const BUSINESS_WINDOWS = [
  { key: "last30", label: "Last 30 nights" },
  { key: "next30", label: "Next 30 nights" },
  { key: "next90", label: "Next 90 nights" },
  { key: "last365", label: "Last 12 months" },
] as const;

export type BusinessWindowKey = (typeof BUSINESS_WINDOWS)[number]["key"];

export type BusinessWindow = { key: BusinessWindowKey; label: string; from: string; to: string };

function plusDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The window asked for (the last 30 nights when the value is anything else), from the hotel's today. */
export function businessWindow(raw: unknown, today: string): BusinessWindow {
  const found = BUSINESS_WINDOWS.find((w) => w.key === raw) ?? BUSINESS_WINDOWS[0];
  const span = (from: number, to: number) => ({ from: plusDays(today, from), to: plusDays(today, to) });
  const range =
    found.key === "next30"
      ? span(0, 29)
      : found.key === "next90"
        ? span(0, 89)
        : found.key === "last365"
          ? span(-365, -1)
          : span(-30, -1);
  return { key: found.key, label: found.label, ...range };
}
