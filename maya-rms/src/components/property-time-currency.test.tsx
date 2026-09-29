// @vitest-environment jsdom
/**
 * The PMS tab shows the time zone and currency saved for the property, as
 * saved. UTC is what a property gets when nothing was read, so it says so in
 * plain words instead of passing it off as the property's own.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { currencyLabel, PropertyTimeAndCurrency } from "./property-time-currency";

afterEach(cleanup);

describe("currencyLabel", () => {
  it("names the code and its symbol, or the code alone when that is its symbol", () => {
    expect(currencyLabel("EUR")).toBe("EUR (€)");
    expect(currencyLabel("USD")).toBe("USD ($)");
    expect(currencyLabel("GBP")).toBe("GBP (£)");
    expect(currencyLabel("CHF")).toBe("CHF");
    expect(currencyLabel(null)).toBe("Not set");
  });
});

describe("PropertyTimeAndCurrency", () => {
  it("shows a real time zone and currency plainly, with nothing added", () => {
    const view = render(<PropertyTimeAndCurrency timezone="Europe/Lisbon" currency="EUR" />);
    expect(screen.getByText("Europe/Lisbon")).toBeTruthy();
    expect(screen.getByText("EUR (€)")).toBeTruthy();
    expect(view.container.textContent).not.toContain("weren't read");
    expect(view.container.textContent).not.toContain("wasn't read");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("says plainly that UTC and US dollars are what a property gets when nothing was read", () => {
    const view = render(<PropertyTimeAndCurrency timezone="UTC" currency="USD" />);
    expect(screen.getByText("USD ($)")).toBeTruthy();
    expect(view.container.textContent).toContain(
      "UTC and US dollars are what a property gets when its time zone and currency weren't read from its system. If either is wrong for your property, send us a message and we'll correct it.",
    );
    expect(screen.getByRole("link", { name: "send us a message" }).getAttribute("href")).toMatch(/^mailto:/);
  });

  it("speaks of the time zone alone when the currency is not the default", () => {
    const view = render(<PropertyTimeAndCurrency timezone="UTC" currency="EUR" />);
    expect(view.container.textContent).toContain(
      "UTC is what a property gets when its time zone wasn't read from its system. If yours is different, send us a message and we'll correct it.",
    );
    expect(view.container.textContent).not.toContain("US dollars");
  });

  it("uses no em dashes", () => {
    const view = render(<PropertyTimeAndCurrency timezone="UTC" currency="USD" />);
    expect(view.container.textContent).not.toContain("—");
  });
});
