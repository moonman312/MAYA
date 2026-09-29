// @vitest-environment jsdom
/**
 * The screen right after paying says, at every stage, that nothing is lost and
 * nothing was charged twice. It says it in plain sentences, with no em dash.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// One router for the whole test, as Next gives: the screen's polling effect
// restarts whenever the router it depends on changes.
const router = { replace: () => {}, refresh: () => {} };
const params = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  useSearchParams: () => params,
}));

const { ConfirmingPayment } = await import("./confirming-payment");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  // The payment never lands in this test, so every stage shows in turn.
  vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ step: "subscribe" }) }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ConfirmingPayment", () => {
  it("reads plainly while waiting, when slow and once it stops checking", async () => {
    const { container } = render(<ConfirmingPayment />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(container.textContent).toContain("Setting up your account. This takes a few seconds.");
    expect(container.textContent).not.toContain("\u2014");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(40_000);
    });
    expect(container.textContent).toContain(
      "Nothing is lost and you have not been charged twice. You can leave this page: we'll email you when it's ready, and your card details are already saved.",
    );
    expect(container.textContent).not.toContain("\u2014");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400_000);
    });
    expect(container.textContent).toContain(
      "We've stopped checking automatically. Nothing is lost and you have not been charged twice. Leave this page and we'll email you when it's ready, or ask again below.",
    );
    expect(container.textContent).not.toContain("\u2014");
  });
});
