// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { WheelGuard } from "@/components/wheel-guard";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

function numberBox(value = "120") {
  const input = document.createElement("input");
  input.type = "number";
  input.value = value;
  document.body.appendChild(input);
  return input;
}

describe("WheelGuard", () => {
  it("leaves a focused number box when the wheel scrolls over it, keeping the number", () => {
    render(<WheelGuard />);
    const input = numberBox();
    input.focus();
    expect(document.activeElement).toBe(input);
    input.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, bubbles: true }));
    expect(document.activeElement).not.toBe(input);
    expect(input.value).toBe("120");
  });

  it("leaves other fields alone", () => {
    render(<WheelGuard />);
    const text = document.createElement("input");
    text.type = "text";
    document.body.appendChild(text);
    text.focus();
    text.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, bubbles: true }));
    expect(document.activeElement).toBe(text);
  });

  it("does not take focus away when the wheel is over something else", () => {
    render(<WheelGuard />);
    const input = numberBox();
    const other = document.createElement("div");
    document.body.appendChild(other);
    input.focus();
    other.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, bubbles: true }));
    expect(document.activeElement).toBe(input);
  });

  it("stops listening once removed", () => {
    const { unmount } = render(<WheelGuard />);
    unmount();
    const input = numberBox();
    input.focus();
    input.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, bubbles: true }));
    expect(document.activeElement).toBe(input);
  });
});
