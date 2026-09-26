// @vitest-environment jsdom
/**
 * The slider's badge and the line under it read the same comparison. 11 of
 * 20 is exactly 55%, so a Greater than 55 rule does not fire, and the badge
 * must not say it does while the line says it does not.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { OccupancySliderLive } from "./occupancy-slider";

afterEach(cleanup);

describe("OccupancySliderLive", () => {
  it("does not fire exactly on the line", () => {
    const view = render(<OccupancySliderLive rooms={20} outOfService={0} booked={11} threshold={55} />);
    const text = view.container.textContent ?? "";
    expect(text).toContain("Your rule does not fire");
    expect(text).toContain("so exactly 55% does not fire.");
  });

  it("fires one booking over the line", () => {
    const view = render(<OccupancySliderLive rooms={20} outOfService={0} booked={12} threshold={55} />);
    expect(view.container.textContent).toContain("Your rule fires");
  });
});
