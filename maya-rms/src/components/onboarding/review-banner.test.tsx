// @vitest-environment jsdom
/**
 * The dashboard's review card: how many things are worth a look, in words
 * with no em dash in them.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingReviewBanner } from "./review-banner";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          connected: true,
          state: { review_completed_at: null },
          job: { status: "completed" },
          proposedFindings: 3,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("OnboardingReviewBanner", () => {
  it("says how many things are worth a look and how long it takes", async () => {
    render(<OnboardingReviewBanner hotelId="hotel-1" />);
    const line = await screen.findByText(/^We found 3 things worth a quick/);
    expect(line.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "We found 3 things worth a quick look. It takes about a minute.",
    );
    expect(document.body.textContent).not.toContain("—");
  });
});
