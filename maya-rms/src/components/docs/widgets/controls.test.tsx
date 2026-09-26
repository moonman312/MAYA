// @vitest-environment jsdom
/**
 * A Segmented group is a radio group: the arrow keys move the choice and the
 * focus together. If only the choice moved, focus would sit on the old option,
 * and Space or Enter there would pick the old option again.
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Segmented } from "./controls";

afterEach(cleanup);

function Billing() {
  const [value, setValue] = useState<"monthly" | "yearly">("monthly");
  return (
    <Segmented
      label="Billing"
      value={value}
      onChange={setValue}
      options={[
        { value: "monthly", label: "Monthly" },
        { value: "yearly", label: "Yearly" },
      ]}
    />
  );
}

describe("Segmented", () => {
  it("moves focus with the arrow keys, and Space on the focused option keeps it", () => {
    const view = render(<Billing />);
    const monthly = view.getByRole("radio", { name: "Monthly" });
    const yearly = view.getByRole("radio", { name: "Yearly" });
    monthly.focus();

    fireEvent.keyDown(monthly, { key: "ArrowRight" });
    expect(document.activeElement).toBe(yearly);
    expect(yearly.getAttribute("aria-checked")).toBe("true");
    expect(yearly.tabIndex).toBe(0);

    // Space or Enter on a button clicks it
    fireEvent.click(document.activeElement!);
    expect(yearly.getAttribute("aria-checked")).toBe("true");
    expect(monthly.getAttribute("aria-checked")).toBe("false");

    fireEvent.keyDown(yearly, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(monthly);
    expect(monthly.getAttribute("aria-checked")).toBe("true");
  });
});
