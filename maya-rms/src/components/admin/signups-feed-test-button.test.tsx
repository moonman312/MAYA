// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SignupsFeedTestButton } from "./signups-feed-test-button";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SignupsFeedTestButton", () => {
  it("posts once and says where to look", async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }) as Response);
    vi.stubGlobal("fetch", fetchSpy);
    const view = render(<SignupsFeedTestButton />);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Send a test line" }));
    });
    expect(fetchSpy).toHaveBeenCalledWith("/api/admin/signups-feed/test", { method: "POST" });
    expect(view.container.textContent).toContain("Queued. Check #maya-signups for it.");
  });

  it("shows the server's reason when it could not send", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({ error: "There's no maya_signups_webhook in Vault yet." }) }) as Response),
    );
    const view = render(<SignupsFeedTestButton />);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Send a test line" }));
    });
    expect(view.container.textContent).toContain("There's no maya_signups_webhook in Vault yet.");
  });
});
