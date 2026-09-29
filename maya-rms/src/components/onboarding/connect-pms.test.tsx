// @vitest-environment jsdom
/**
 * The connect step right after payment: the promise under the heading is in
 * plain words, with no em dash.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }) }));
vi.mock("@/lib/analytics/track", () => ({ track: () => {}, useTrackOnce: () => {} }));

const { ConnectPms } = await import("./connect-pms");

afterEach(() => {
  cleanup();
});

describe("ConnectPms", () => {
  it("says what connecting takes without an em dash", () => {
    render(
      <ConnectPms
        pmsOptions={[
          {
            type: "cloudbeds",
            displayName: "Cloudbeds",
            authKind: "oauth2_authorization_code",
            configured: true,
            missingEnvVars: [],
            callbackUrl: null,
            onboardingSupported: true,
          },
        ]}
      />,
    );
    const line = screen.getByText(/^Last thing\./);
    expect(line.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "Last thing. Pick your property management system, sign in on their site, and you'll be brought right back. No keys to copy, nothing to configure on their end.",
    );
    expect(document.body.textContent).not.toContain("—");
  });
});
