// @vitest-environment jsdom
/**
 * A rate the hotel changed in its PMS shows in the editor like any manual
 * price: it can be cleared, and the Clear button says where it came from.
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManualPriceEditor } from "./manual-price-editor";

afterEach(cleanup);

const base = {
  hotelId: "hotel-1",
  roomTypeId: "rt-1",
  roomTypeName: "King",
  stayDate: "2026-10-05",
  currentPrice: 180,
  pmsName: "Cloudbeds",
  onSaved: () => {},
};

describe("ManualPriceEditor", () => {
  it("offers Clear on a rate changed in the PMS, saying so on hover", () => {
    const view = render(
      <ManualPriceEditor {...base} manualPrice={{ price: 180, set_at: "2026-10-01T12:00:00Z", source: "pms", pms_type: "cloudbeds" }} />,
    );
    const clear = view.getByRole("button", { name: "Clear" });
    expect(clear.getAttribute("title")).toBe("Changed in Cloudbeds. Clear hands the night back to your rules.");
    expect((view.getByLabelText("Manual price for King") as HTMLInputElement).value).toBe("180");

    fireEvent.click(view.getByRole("button", { name: "What a manual price does" }));
    const help = view.getByRole("group", { name: "Setting a price yourself" }).textContent ?? "";
    expect(help).toContain("A rate changed in Cloudbeds is kept the same way, once MAYA's own price has been there for an hour.");
    expect(help).not.toContain("—");
  });

  it("shows the property's currency symbol beside the box, and dollars when none is given", () => {
    const euro = render(<ManualPriceEditor {...base} manualPrice={null} currencySymbol="€" />);
    expect(euro.getByLabelText("Manual price for King").closest("label")?.textContent).toBe("€");
    euro.unmount();
    const plain = render(<ManualPriceEditor {...base} manualPrice={null} />);
    expect(plain.getByLabelText("Manual price for King").closest("label")?.textContent).toBe("$");
  });

  it("keeps a typed price's Clear as it was", () => {
    const view = render(<ManualPriceEditor {...base} manualPrice={{ price: 150, set_at: "2026-10-01T12:00:00Z", source: "maya" }} />);
    expect(view.getByRole("button", { name: "Clear" }).getAttribute("title")).toBeNull();
  });

  it("has no Clear on a night that has passed, and keeps it for tonight", () => {
    const manualPrice = { price: 150, set_at: "2026-10-01T12:00:00Z", source: "maya" as const };
    const past = render(<ManualPriceEditor {...base} manualPrice={manualPrice} hotelToday="2026-10-06" />);
    expect(past.queryByRole("button", { name: "Clear" })).toBeNull();
    cleanup();
    const tonight = render(<ManualPriceEditor {...base} manualPrice={manualPrice} hotelToday="2026-10-05" />);
    expect(tonight.getByRole("button", { name: "Clear" })).toBeTruthy();
  });

  it("shows the property's currency symbol by the amount", () => {
    const view = render(<ManualPriceEditor {...base} manualPrice={null} currencySymbol="€" />);
    expect(view.getByLabelText("Manual price for King").closest("label")?.textContent).toContain("€");
    expect(view.getByLabelText("Manual price for King").closest("label")?.textContent).not.toContain("$");
  });

  it("says a clear on a passed night had nothing to clear", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true, cells: 0, passed: true })));
    vi.stubGlobal("fetch", fetchSpy);
    const view = render(
      <ManualPriceEditor {...base} manualPrice={{ price: 150, set_at: "2026-10-01T12:00:00Z", source: "maya" }} />,
    );
    fireEvent.click(view.getByRole("button", { name: "Clear" }));
    expect((await view.findByRole("status")).textContent).toBe("This night has passed, so there is nothing to clear.");
    vi.unstubAllGlobals();
  });
});
