// @vitest-environment jsdom
/**
 * Checkout refuses a caller with no Terms on file (428, terms_required). The
 * subscribe screen has to bring the accept screen back rather than show that
 * as a dead-end error, and carry on to Stripe once they accept.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => {}, refresh: () => {} }) }));
vi.mock("@/lib/analytics/track", () => ({ track: () => {}, useTrackOnce: () => {} }));

const { SubscribeStep } = await import("./subscribe-step");
const { TERMS_ACCEPTED_EVENT, TERMS_REQUIRED_EVENT } = await import("@/components/legal/terms-gate");

let checkoutAnswers: Array<() => Response> = [];
let checkoutCalls = 0;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  checkoutCalls = 0;
  checkoutAnswers = [];
  vi.stubGlobal("fetch", async (url: string) => {
    if (url === "/api/billing/checkout") {
      const answer = checkoutAnswers[checkoutCalls] ?? (() => json({ error: "boom" }, 500));
      checkoutCalls += 1;
      return answer();
    }
    return json({});
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderReady() {
  render(
    <SubscribeStep
      lockPms
      pmsOptions={[{ type: "cloudbeds", displayName: "Cloudbeds", requiresSignupCode: false }]}
    />,
  );
  fireEvent.change(screen.getByPlaceholderText("e.g. 24"), { target: { value: "24" } });
}

describe("SubscribeStep when the Terms are not on file", () => {
  it("brings back the accept screen, then goes on to checkout once accepted", async () => {
    checkoutAnswers = [
      () => json({ error: "Accept the Terms of Service to continue.", reason: "terms_required" }, 428),
      () => json({ error: "stop here" }, 500),
    ];
    const asked = vi.fn();
    window.addEventListener(TERMS_REQUIRED_EVENT, asked);
    renderReady();

    fireEvent.click(screen.getByRole("button", { name: "Continue to payment" }));
    await waitFor(() => expect(asked).toHaveBeenCalledTimes(1));
    expect(checkoutCalls).toBe(1);
    expect(screen.queryByText(/Accept the Terms/)).toBeNull();

    act(() => {
      window.dispatchEvent(new Event(TERMS_ACCEPTED_EVENT));
    });
    await waitFor(() => expect(checkoutCalls).toBe(2));
    window.removeEventListener(TERMS_REQUIRED_EVENT, asked);
  });

  it("shows any other refusal as an error, without the accept screen", async () => {
    checkoutAnswers = [() => json({ error: "This property already has a subscription." }, 409)];
    const asked = vi.fn();
    window.addEventListener(TERMS_REQUIRED_EVENT, asked);
    renderReady();

    fireEvent.click(screen.getByRole("button", { name: "Continue to payment" }));
    await waitFor(() => expect(screen.getByText(/already has a subscription/)).not.toBeNull());
    expect(asked).not.toHaveBeenCalled();
    window.removeEventListener(TERMS_REQUIRED_EVENT, asked);
  });
});
