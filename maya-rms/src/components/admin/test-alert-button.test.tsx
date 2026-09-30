// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TestAlertButton } from "./test-alert-button";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TestAlertButton", () => {
  it("is off, and says why, when the alert channel is not set up", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const problem = "MAYA_ALERT_WEBHOOK isn't set for this app, so there's nowhere to send alerts.";
    const view = render(<TestAlertButton problem={problem} />);
    const button = view.getByRole("button", { name: "Send a test alert" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(view.container.textContent).toContain(problem);
    fireEvent.click(button);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts once and says which function sent it", async () => {
    const fetchSpy = vi.fn(
      async () => ({ ok: true, json: async () => ({ ok: true, fn: "cloudbeds-scheduled-sync", minSeverity: "warn" }) }) as Response,
    );
    vi.stubGlobal("fetch", fetchSpy);
    const view = render(<TestAlertButton problem={null} />);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Send a test alert" }));
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith("/api/admin/alerts/test", { method: "POST" });
    expect(view.container.textContent).toContain("Sent through cloudbeds-scheduled-sync. Check the alert channel for it.");
    expect(view.container.textContent).not.toContain("critical problems only");
  });

  it("says when real alerts go out for critical problems only", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, fn: "cloudbeds-scheduled-sync", minSeverity: "critical" }) }) as Response),
    );
    const view = render(<TestAlertButton problem={null} />);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Send a test alert" }));
    });
    expect(view.container.textContent).toContain("Real alerts go out for critical problems only (MAYA_ALERT_MIN_SEVERITY).");
  });

  it("shows the server's reason when it could not send", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({ error: "The alert channel refused the message (HTTP 404)." }) }) as Response),
    );
    const view = render(<TestAlertButton problem={null} />);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Send a test alert" }));
    });
    expect(view.container.textContent).toContain("The alert channel refused the message (HTTP 404).");
  });
});
