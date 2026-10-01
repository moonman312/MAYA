/**
 * Which currencies a property may connect in for now (Jake, 2026-09-30,
 * audits A20 and A58): dollar, euro and pound style ones, with two decimals
 * and prices in the same range as US dollars.
 */
import { describe, expect, it } from "vitest";
import { currencyRefusalFor } from "@/lib/onboarding/currency-gate";
import {
  SUPPORTED_CURRENCIES,
  currencyCode,
  currencySupported,
} from "../../../supabase/functions/_shared/pms/currencies";

describe("SUPPORTED_CURRENCIES", () => {
  it("holds the dollar, euro and pound style currencies", () => {
    for (const code of ["USD", "CAD", "AUD", "NZD", "EUR", "GBP", "CHF"]) expect(SUPPORTED_CURRENCIES).toContain(code);
  });

  it("leaves out currencies without cents, and those whose nights run into the thousands", () => {
    // No minor unit: yen, won, Vietnamese dong, Icelandic krona. Large
    // numbers: rupiah, Hong Kong and New Taiwan dollars, pesos, rupees, baht.
    for (const code of ["JPY", "KRW", "VND", "ISK", "IDR", "HKD", "TWD", "MXN", "INR", "THB", "COP", "CLP"]) {
      expect(SUPPORTED_CURRENCIES).not.toContain(code);
    }
  });

  it("is a list of distinct ISO codes", () => {
    expect(new Set(SUPPORTED_CURRENCIES).size).toBe(SUPPORTED_CURRENCIES.length);
    for (const code of SUPPORTED_CURRENCIES) expect(code).toMatch(/^[A-Z]{3}$/);
  });
});

describe("currencySupported", () => {
  it("reads the code as stored: trimmed, any case", () => {
    expect(currencyCode(" eur ")).toBe("EUR");
    expect(currencySupported(" eur ")).toBe(true);
    expect(currencySupported("KRW")).toBe(false);
  });

  it("lets a system that reports no currency through, as US dollars", () => {
    for (const none of [null, undefined, "", "  "]) expect(currencySupported(none)).toBe(true);
  });
});

describe("currencyRefusalFor", () => {
  it("is null for a currency that may connect", () => {
    expect(currencyRefusalFor("GBP")).toBeNull();
    expect(currencyRefusalFor(null)).toBeNull();
  });

  it("names the currency in a plain sentence about the owner's property", () => {
    const line = currencyRefusalFor("jpy")!;
    expect(line).toBe(
      "Your property's system uses JPY. MAYA doesn't price in JPY yet, so nothing was set up or imported. Email us and we'll tell you when it does.",
    );
    expect(line).not.toMatch(/[—–]/);
    expect(line).not.toMatch(/\b(learns|knows|thinks)\b/);
  });
});
