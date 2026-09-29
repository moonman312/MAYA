// @vitest-environment jsdom
/**
 * Checkout refuses a caller with no Terms on file (428, terms_required). The
 * subscribe screen has to bring the accept screen back rather than show that
 * as a dead-end error, and carry on to Stripe once they accept.
 *
 * And an owner whose property has a subscription but no PMS yet can reach
 * cancellation from where they land (the connect step, or this screen).
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => {}, refresh: () => {} }) }));
vi.mock("@/lib/analytics/track", () => ({ track: () => {}, useTrackOnce: () => {} }));

const { SubscribeStep } = await import("./subscribe-step");
const { TERMS_ACCEPTED_EVENT, TERMS_REQUIRED_EVENT } = await import("@/components/legal/terms-gate");

let checkoutAnswers: Array<() => Response> = [];
let checkoutCalls = 0;
let portalBodies: unknown[] = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  checkoutCalls = 0;
  checkoutAnswers = [];
  portalBodies = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url === "/api/billing/portal") {
      portalBodies.push(JSON.parse(String(init?.body)));
      return json({ error: "not in a test" }, 502);
    }
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

const offer = { hotelId: "hotel-pending", name: null, cancelAtPeriodEnd: false };

describe("SubscribeStep and a subscription already on the property", () => {
  it("offers Manage billing or cancel only when asked to", async () => {
    const { rerender } = render(<SubscribeStep />);
    expect(screen.queryByRole("button", { name: "Manage billing or cancel" })).toBeNull();
    rerender(<SubscribeStep manageBilling={offer} />);
    expect(screen.getByRole("button", { name: "Manage billing or cancel" })).not.toBeNull();
  });

  it("names the property, and sends which one it is", async () => {
    render(<SubscribeStep manageBilling={{ ...offer, hotelId: "hotel-b", name: "Driftwood Inn" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Manage billing or cancel for Driftwood Inn" }));
    await waitFor(() => expect(portalBodies).toEqual([{ pending: true, hotelId: "hotel-b" }]));
  });

  it("says it is already cancelling instead of offering the link again", () => {
    render(<SubscribeStep manageBilling={{ ...offer, cancelAtPeriodEnd: true }} />);
    expect(screen.queryByRole("button", { name: /Manage billing or cancel/ })).toBeNull();
    expect(screen.getByText("Cancels at the end of the period")).not.toBeNull();
  });
});

describe("SubscribeStep on a restart", () => {
  // Checkout grants a restart no trial of any kind, a code's own included. The
  // panel says "Billed when you finish checkout." whatever code is typed.
  let validateBodies: Record<string, unknown>[] = [];

  beforeEach(() => {
    validateBodies = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url === "/api/billing/validate-code") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        validateBodies.push(body);
        // Even an effect that still carried free days must not reach the panel.
        return json({ valid: true, grants: body.restart ? "No free days on a restart." : "30 days free.", effect: { trialDays: 30, percentOff: 20, discountDuration: "forever" } });
      }
      return json({});
    });
  });

  function renderWithCode(restart: boolean) {
    render(
      <SubscribeStep
        restart={restart}
        initialRooms={24}
        lockPms
        pmsOptions={[{ type: "cloudbeds", displayName: "Cloudbeds", requiresSignupCode: false }]}
      />,
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "MHSFOUNDER" } });
  }

  it("says billed when you finish checkout, with a trial code typed", async () => {
    renderWithCode(true);
    await screen.findByText("No free days on a restart.");
    expect(validateBodies.at(-1)).toMatchObject({ code: "MHSFOUNDER", restart: true });
    expect(screen.getByText("Billed when you finish checkout. Cancel anytime.")).not.toBeNull();
    expect(screen.queryByText(/^Nothing today/)).toBeNull();
    // The code's discount still shows: the list price struck through beside it.
    expect(document.querySelector("s")).not.toBeNull();
  });

  it("still shows a code's free days on a first signup", async () => {
    renderWithCode(false);
    await screen.findByText("30 days free.");
    expect(validateBodies.at(-1)).not.toHaveProperty("restart");
    expect(screen.getByText(/^Nothing today/)).not.toBeNull();
  });
});

describe("SubscribeStep wording", () => {
  const cloudbeds = (requiresSignupCode: boolean) => [
    { type: "cloudbeds", displayName: "Cloudbeds", requiresSignupCode },
  ];

  it("has no em dash on a cancelled checkout with an optional code and Not now", () => {
    const { container } = render(
      <SubscribeStep cancelled hotelId="hotel-1" deferrable lockPms pmsOptions={cloudbeds(false)} />,
    );
    expect(container.textContent).toContain("No charge was made: you left checkout before finishing.");
    expect(container.textContent).toContain("Got a discount or trial code? Enter it here, or leave this blank.");
    expect(screen.getByRole("button", { name: "Not now, set this property up later" })).not.toBeNull();
    expect(container.textContent).not.toContain("\u2014");
  });

  it("has no em dash on a trial with a required code", () => {
    const { container } = render(
      <SubscribeStep lockPms pmsOptions={cloudbeds(true)} baseTrialDays={7} initialRooms={24} />,
    );
    expect(container.textContent).toContain("MAYA is invite-only for now, so you'll have been given a code.");
    expect(container.textContent).toMatch(/Nothing today\. Your first charge is \$[\d,.]+ on /);
    expect(container.textContent).not.toContain("\u2014");
  });

  it("has no em dash when the code check finds the session gone", async () => {
    vi.stubGlobal("fetch", async () => json({ error: "Not signed in" }, 401));
    const { container } = render(<SubscribeStep lockPms pmsOptions={cloudbeds(true)} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "MHSFOUNDER" } });
    await screen.findByText("Your session expired. Sign in again and retry.");
    expect(container.textContent).not.toContain("\u2014");
  });
});

describe("ConnectPms", () => {
  it("offers Manage billing or cancel when the pending property has a subscription", async () => {
    const { ConnectPms } = await import("./connect-pms");
    const { rerender } = render(<ConnectPms pmsOptions={[]} />);
    expect(screen.queryByRole("button", { name: "Manage billing or cancel" })).toBeNull();
    rerender(<ConnectPms pmsOptions={[]} manageBilling={offer} />);
    fireEvent.click(screen.getByRole("button", { name: "Manage billing or cancel" }));
    await waitFor(() => expect(portalBodies).toEqual([{ pending: true, hotelId: "hotel-pending" }]));
  });
});
