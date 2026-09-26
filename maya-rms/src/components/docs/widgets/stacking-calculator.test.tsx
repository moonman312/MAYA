// @vitest-environment jsdom
/**
 * The calculator publishes what MAYA would, and names the limit MAYA names:
 * the price is rounded to the cent before the floor and ceiling look at it,
 * and the ceiling the reader typed is checked first.
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StackingCalculatorLive } from "./stacking-calculator";

afterEach(cleanup);

function type(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

describe("StackingCalculatorLive", () => {
  it("publishes the ceiling you typed when the floor is above it", () => {
    const view = render(<StackingCalculatorLive />);
    type(view.getByLabelText("Starting price"), "500");
    type(view.getByLabelText("Floor"), "400");
    type(view.getByLabelText("Ceiling"), "300");
    const text = view.container.textContent ?? "";
    expect(text).toContain("Published$300.00");
    expect(text).toContain("past your $300.00 ceiling");
  });

  it("does not say a price that rounds onto the floor was stopped by it", () => {
    const view = render(<StackingCalculatorLive />);
    for (const decrease of view.getAllByRole("radio", { name: "Decrease" })) fireEvent.click(decrease);
    const [first, second] = view.getAllByLabelText("Amount");
    type(first, "10");
    type(second, "30");
    type(view.getByLabelText("Floor"), "126");
    const text = view.container.textContent ?? "";
    expect(text).toContain("Published$126.00");
    expect(text).not.toContain("below your");
    expect(text).toContain("so $126.00 is published.");
  });
});
