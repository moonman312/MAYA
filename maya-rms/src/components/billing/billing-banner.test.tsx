// @vitest-environment jsdom
/**
 * The dashboard banner's one button has to match its sentence. A paused
 * subscription says "Email us and we'll get it running again", and the billing
 * page has no restart for it, so a "Restart MAYA" button beside that sentence
 * points at something that isn't there.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { BillingBanner } = await import("./billing-banner");

function answer(body: Record<string, unknown>) {
  vi.stubGlobal("fetch", async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const stoppedTitle = "MAYA has paused work on this property";

describe("BillingBanner", () => {
  it("emails us instead of offering a restart when the subscription is paused", async () => {
    answer({
      applicable: true,
      entitled: false,
      tone: "stopped",
      title: stoppedTitle,
      detail: "Your subscription is on hold. Email us and we'll get it running again.",
      emailSubject: "Paused subscription",
    });
    render(<BillingBanner hotelId="hotel-1" />);
    const link = await screen.findByRole("link", { name: "Email us" });
    expect(link.getAttribute("href")).toBe(
      "mailto:info@modern-hospitality-solutions.com?subject=Paused%20subscription",
    );
    expect(screen.queryByText("Restart MAYA")).toBeNull();
  });

  it("keeps Restart MAYA for a cancelled subscription", async () => {
    answer({
      applicable: true,
      entitled: false,
      tone: "stopped",
      title: stoppedTitle,
      detail: "Your subscription was cancelled, so starting again means a new one.",
      emailSubject: null,
    });
    render(<BillingBanner hotelId="hotel-1" />);
    const link = await screen.findByRole("link", { name: "Restart MAYA" });
    expect(link.getAttribute("href")).toBe("/account/billing");
  });

  it("keeps Fix it for a warning the billing page can fix", async () => {
    answer({ applicable: true, entitled: true, tone: "warn", title: "Your last payment did not go through", detail: "x" });
    render(<BillingBanner hotelId="hotel-1" />);
    const link = await screen.findByRole("link", { name: "Fix it" });
    expect(link.getAttribute("href")).toBe("/account/billing");
  });

  it("emails us about a room count above what we sell self-serve", async () => {
    answer({
      applicable: true,
      entitled: true,
      tone: "warn",
      title: "You're billed for 20 rooms but running 600",
      detail: "That's above what we sell self-serve. Email us and we'll set it up with you.",
      emailSubject: "Over 500 rooms",
    });
    render(<BillingBanner hotelId="hotel-1" />);
    const link = await screen.findByRole("link", { name: "Email us" });
    expect(link.getAttribute("href")).toBe(
      "mailto:info@modern-hospitality-solutions.com?subject=Over%20500%20rooms",
    );
    expect(screen.queryByText("Fix it")).toBeNull();
  });
});
