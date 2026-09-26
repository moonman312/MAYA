// @vitest-environment jsdom
/**
 * The playground quotes the note "How did we know?" would show, and the app
 * shows at most one: the engine's guard, the last check that changed the
 * level. With nothing expected and nothing received it shows none.
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BookingSpeedPlaygroundLive } from "./booking-speed-playground";

afterEach(cleanup);

const NOISE = "the gap was small enough to be ordinary noise";
const EXTREME = "so we softened it one step";
const FEW = "We found only a few genuinely comparable nights";

function set(view: ReturnType<typeof render>, expected: string, received: string, similar: string) {
  fireEvent.change(view.getByLabelText("Expected bookings"), { target: { value: expected } });
  fireEvent.change(view.getByLabelText("Bookings received"), { target: { value: received } });
  fireEvent.change(view.getByLabelText("Similar nights found"), { target: { value: similar } });
  return view.container.textContent ?? "";
}

describe("BookingSpeedPlaygroundLive", () => {
  it("quotes no note when nothing was expected and nothing came in", () => {
    const text = set(render(<BookingSpeedPlaygroundLive />), "0", "0", "5");
    expect(text).toContain("The night reads Normal");
    expect(text).not.toContain(NOISE);
    expect(text).not.toContain(EXTREME);
    expect(text).not.toContain(FEW);
  });

  it("quotes only the last check's note when two checks moved the level", () => {
    const text = set(render(<BookingSpeedPlaygroundLive />), "1", "4", "3");
    expect(text).toContain("The night reads Faster Than Normal");
    expect(text).toContain(FEW);
    expect(text).not.toContain(EXTREME);
  });

  it("still quotes the noise note when the gap was small but real", () => {
    const text = set(render(<BookingSpeedPlaygroundLive />), "20", "26", "5");
    expect(text).toContain("The night reads Normal");
    expect(text).toContain(NOISE);
  });
});
