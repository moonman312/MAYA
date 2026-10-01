/**
 * The currencies MAYA takes a new property on in, for now (Jake, 2026-09-30,
 * audits A20 and A58): dollar, euro and pound style currencies, whose prices
 * run in the same range as the US dollar's and carry two decimals.
 *
 * Everything that puts a price together assumes both:
 *   - Prices are rounded to two decimals (engine/pricing.ts), so a currency
 *     without cents (yen, won) would be sent amounts it does not have: 12,345
 *     with a 10% raise went out as 13,579.5.
 *   - "No ceiling" is the plain number 99,999.99 (room_types.ceiling_price's
 *     default), so in a currency where a night costs 150,000 (won, rupiah,
 *     dong) every price was held to 99,999.99 and sent.
 *   - The floor read from a property's rates never goes under 10 (suggest.ts
 *     MIN_DATA_FLOOR), which means nothing in those currencies either.
 * Each currency here has two decimals in ISO 4217 and a unit worth between
 * about a third of a US dollar and one and a half, so a night reads like a
 * dollar night: 80 to 800, never 80,000.
 *
 * Checked when a property connects, in both flows (lib/onboarding/connect.ts
 * and lib/pms/marketplace-connect.ts): a property whose system uses any other
 * currency is stopped there with a plain message and a pms.currency_refused
 * event, before anything about it is stored, so it is never half imported. A
 * property already in MAYA is never checked. A system that reports no
 * currency is taken in US dollars, as it always was.
 */
export const SUPPORTED_CURRENCIES: readonly string[] = [
  "USD", // US dollar
  "CAD", // Canadian dollar
  "AUD", // Australian dollar
  "NZD", // New Zealand dollar
  "SGD", // Singapore dollar
  "BSD", // Bahamian dollar
  "BMD", // Bermudian dollar
  "KYD", // Cayman Islands dollar
  "BBD", // Barbados dollar
  "BZD", // Belize dollar
  "XCD", // East Caribbean dollar
  "FJD", // Fiji dollar
  "EUR", // euro
  "GBP", // pound sterling
  "CHF", // Swiss franc
];

/** The ISO code as MAYA stores it: trimmed and upper case. Null for nothing. */
export function currencyCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  return code.length > 0 ? code : null;
}

/**
 * Whether a property whose system reports `raw` may connect. No currency at
 * all may: it is stored as US dollars, as it always was.
 */
export function currencySupported(raw: unknown): boolean {
  const code = currencyCode(raw);
  return code == null || SUPPORTED_CURRENCIES.includes(code);
}
