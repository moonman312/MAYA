// @vitest-environment jsdom
/**
 * A rate the hotel changed in its PMS shows in the editor like any manual
 * price: it can be cleared, and the Clear button says where it came from.
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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
    expect(clear.getAttribute("title")).toBe("Changed in Cloudbeds. Clear hands the night back to MAYA.");
    expect((view.getByLabelText("Manual price for King") as HTMLInputElement).value).toBe("180");

    fireEvent.click(view.getByRole("button", { name: "What a manual price does" }));
    const help = view.getByRole("tooltip").textContent ?? "";
    expect(help).toContain("A rate changed in Cloudbeds on a night MAYA already sent is kept the same way.");
    expect(help).not.toContain("—");
  });

  it("keeps a typed price's Clear as it was", () => {
    const view = render(<ManualPriceEditor {...base} manualPrice={{ price: 150, set_at: "2026-10-01T12:00:00Z", source: "maya" }} />);
    expect(view.getByRole("button", { name: "Clear" }).getAttribute("title")).toBeNull();
  });
});
