// @vitest-environment jsdom
/**
 * The billing and review banners belong to the property on screen: switching
 * property reads them again, and the last property's banner goes at once
 * rather than waiting for the new read.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BillingBanner } from "./billing/billing-banner";
import { OnboardingReviewBanner } from "./onboarding/review-banner";

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

/** What each property's status route answers; the cookie decides which one a request reads. */
let answers: Record<string, Record<string, unknown>> = {};
let active = "hotel-1";
let held: ((r: Response) => void) | null = null;
let hold = false;
let calls: string[] = [];

beforeEach(() => {
  answers = {};
  active = "hotel-1";
  hold = false;
  held = null;
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const body = answers[active]?.[url];
      const res = body === undefined ? new Response("{}", { status: 404 }) : json(body);
      if (!hold) return res;
      return new Promise<Response>((resolve) => {
        held = () => resolve(res);
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const reviewReady = (count: number) => ({
  connected: true,
  state: { review_completed_at: null },
  job: { status: "completed" },
  proposedFindings: count,
});

describe("BillingBanner across a property switch", () => {
  it("reads the new property's billing, and drops the old banner before the answer comes", async () => {
    answers["hotel-1"] = {
      "/api/billing/status": { applicable: true, tone: "warn", title: "Your last payment didn't go through", detail: "Update your card." },
    };
    answers["hotel-2"] = { "/api/billing/status": { applicable: false } };
    const view = render(<BillingBanner hotelId="hotel-1" />);
    expect(await screen.findByText("Your last payment didn't go through")).toBeTruthy();

    active = "hotel-2";
    hold = true;
    view.rerender(<BillingBanner hotelId="hotel-2" />);
    expect(screen.queryByText("Your last payment didn't go through")).toBeNull();
    held?.(new Response());
    await waitFor(() => expect(calls.filter((c) => c === "/api/billing/status")).toHaveLength(2));
    expect(screen.queryByText("Your last payment didn't go through")).toBeNull();
  });

  it("shows the new property's own banner", async () => {
    answers["hotel-1"] = { "/api/billing/status": { applicable: false } };
    answers["hotel-2"] = {
      "/api/billing/status": { applicable: true, tone: "stopped", title: "MAYA has paused work on this property", detail: "Restart to carry on." },
    };
    const view = render(<BillingBanner hotelId="hotel-1" />);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(screen.queryByRole("status")).toBeNull();

    active = "hotel-2";
    view.rerender(<BillingBanner hotelId="hotel-2" />);
    expect(await screen.findByText("MAYA has paused work on this property")).toBeTruthy();
  });
});

describe("OnboardingReviewBanner across a property switch", () => {
  it("drops the last property's review card and reads the new property's", async () => {
    answers["hotel-1"] = { "/api/onboarding/status": reviewReady(3) };
    answers["hotel-2"] = { "/api/onboarding/status": { connected: true, state: { review_completed_at: "2026-09-01T00:00:00Z" }, job: { status: "completed" }, proposedFindings: 0 } };
    const view = render(<OnboardingReviewBanner hotelId="hotel-1" />);
    await waitFor(() => expect(document.querySelector('a[href="/onboarding/review"]')).not.toBeNull());

    active = "hotel-2";
    hold = true;
    view.rerender(<OnboardingReviewBanner hotelId="hotel-2" />);
    expect(document.querySelector('a[href="/onboarding/review"]')).toBeNull();
    held?.(new Response());
    await waitFor(() => expect(calls.filter((c) => c === "/api/onboarding/status")).toHaveLength(2));
    expect(document.querySelector('a[href="/onboarding/review"]')).toBeNull();
  });

  it("shows the new property's review card when it has one", async () => {
    answers["hotel-1"] = { "/api/onboarding/status": { connected: true, job: { status: "running" } } };
    answers["hotel-2"] = { "/api/onboarding/status": reviewReady(2) };
    const view = render(<OnboardingReviewBanner hotelId="hotel-1" />);
    await waitFor(() => expect(calls).toHaveLength(1));

    active = "hotel-2";
    view.rerender(<OnboardingReviewBanner hotelId="hotel-2" />);
    await waitFor(() => expect(document.querySelector('a[href="/onboarding/review"]')).not.toBeNull());
  });
});
