// @vitest-environment jsdom
/**
 * A tap on a phone is a hover, then a focus, then a click, and a keyboard
 * press of Enter comes after the focus. Each of those shows the spot's note,
 * so the click at the end must not hide it again.
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AppTourLive } from "./app-tour";

afterEach(cleanup);

function panel(container: HTMLElement) {
  return container.querySelector("[aria-live]")!.textContent ?? "";
}

describe("AppTourLive", () => {
  it("shows a spot's note after a tap", () => {
    const view = render(<AppTourLive />);
    const spot = view.getByRole("button", { name: "3. Banners" });
    fireEvent.mouseOver(spot);
    fireEvent.focus(spot);
    fireEvent.click(spot);
    expect(spot.getAttribute("aria-pressed")).toBe("true");
    expect(panel(view.container)).toContain("Banners.");
  });

  it("shows a spot's note after tabbing to it and pressing Enter", () => {
    const view = render(<AppTourLive />);
    const spot = view.getByRole("button", { name: "5. The Property dropdown" });
    fireEvent.focus(spot);
    fireEvent.click(spot);
    expect(spot.getAttribute("aria-pressed")).toBe("true");
    expect(panel(view.container)).toContain("The Property dropdown.");
  });
});
