// @vitest-environment jsdom
/**
 * Every switch that turns a hotel live asks first, and nothing reaches the
 * server until the confirm. What the dialog says has to be what the push does.
 */
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoLiveDialog, goLiveCopy, pmsConnected } from "./go-live-dialog";
import { StarterRules } from "./onboarding/review-findings";
import { SimulationModeToggle } from "./admin/simulation-mode-toggle";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const text = (lines: { title: string; lines: string[] }) => [lines.title, ...lines.lines].join(" ");

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("goLiveCopy", () => {
  it("names the PMS, the window and the cycle, in plain words with no dashes", () => {
    const cloudbeds = goLiveCopy({ pmsType: "cloudbeds", windowDays: 60 });
    expect(cloudbeds).toEqual({
      title: "Send prices to Cloudbeds?",
      lines: [
        "MAYA starts sending its prices for the next 60 nights to Cloudbeds on the next cycle, in about 5 minutes.",
        "Each price it sends replaces that night's rate in Cloudbeds, and a night is sent again whenever its price changes.",
      ],
    });
    expect(text(goLiveCopy({ pmsType: "think", windowDays: 30 }))).toContain("for the next 30 nights to Think Reservations");
    expect(text(goLiveCopy({ pmsType: null, windowDays: null }))).toBe(
      "Send prices to your PMS? MAYA starts sending its prices to your PMS on the next cycle, in about 5 minutes. Each price it sends replaces that night's rate in your PMS, and a night is sent again whenever its price changes.",
    );
    for (const c of [cloudbeds, goLiveCopy({ pmsType: "mews", windowDays: 60 })]) expect(text(c)).not.toMatch(/[—–]/);
  });

  it("says nothing is sent when the hotel has no connection the sync picks up", () => {
    expect(goLiveCopy({ pmsType: null, windowDays: 60, connected: false })).toEqual({
      title: "Go live?",
      lines: ["No PMS is connected, so nothing is sent until one is."],
    });
    expect(text(goLiveCopy({ pmsType: "cloudbeds", windowDays: 60, connected: false }))).not.toContain("Cloudbeds");
    // Still sent: a connection with sync errors is still synced and pushed to.
    for (const status of ["connected", "degraded", "error"]) expect(pmsConnected("cloudbeds", status)).toBe(true);
    expect(pmsConnected(null, null)).toBe(false);
    expect(pmsConnected("cloudbeds", null)).toBe(false);
    expect(pmsConnected("think", "disconnected")).toBe(false);
    expect(pmsConnected("cloudbeds", "pending")).toBe(false);
  });

  it("doesn't promise to send to a PMS MAYA has no rate push for", () => {
    expect(goLiveCopy({ pmsType: "mews", windowDays: 60 })).toEqual({
      title: "Go live?",
      lines: ["MAYA doesn't send rates to Mews yet, so nothing is sent. The hotel only shows as live."],
    });
  });
});

describe("GoLiveDialog", () => {
  it("renders nothing while closed, and confirms or cancels", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const closed = render(<GoLiveDialog open={false} pmsType="cloudbeds" windowDays={60} onConfirm={onConfirm} onCancel={onCancel} />);
    expect(closed.queryByRole("dialog")).toBeNull();
    cleanup();

    const view = render(<GoLiveDialog open pmsType="cloudbeds" windowDays={60} onConfirm={onConfirm} onCancel={onCancel} />);
    expect(view.getByRole("dialog", { name: "Send prices to Cloudbeds?" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Go live" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(view.getByRole("button", { name: "Not yet" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("can't be confirmed twice while switching", () => {
    const onConfirm = vi.fn();
    const view = render(<GoLiveDialog open busy pmsType="think" windowDays={60} onConfirm={onConfirm} onCancel={() => {}} />);
    const button = view.getByRole("button", { name: "Switching…" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});

describe("the onboarding go-live button", () => {
  const status = {
    connected: true,
    simulationMode: true,
    pmsType: "cloudbeds",
    pushWindowDays: 60,
    job: { stats: { starterRules: [{ name: "Busy nights", explanation: "Raises busy nights." }] } },
  } as unknown as Parameters<typeof StarterRules>[0]["status"];

  it("asks before it calls the server, and goes live only on the confirm", async () => {
    const view = render(<StarterRules status={status} />);

    fireEvent.click(view.getByRole("button", { name: "Turn them on for real" }));
    expect(fetchSpy).not.toHaveBeenCalled();
    const dialog = view.getByRole("dialog");
    expect(dialog.textContent).toContain("MAYA starts sending its prices for the next 60 nights to Cloudbeds");
    // The Terms line sits with the press it describes.
    expect(dialog.textContent).toContain("You're confirming you've reviewed your rules and limits");

    fireEvent.click(view.getByRole("button", { name: "Not yet" }));
    expect(view.queryByRole("dialog")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole("button", { name: "Turn them on for real" }));
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Go live" }));
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe("/api/onboarding/activate");
    await waitFor(() => expect(view.container.textContent).toContain("Live: your rules are now managing prices"));
    expect(view.queryByRole("dialog")).toBeNull();
  });

  it("keeps the dialog open with the server's reason when going live fails", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ error: "You need admin access on this property to go live." }), { status: 403 }));
    const view = render(<StarterRules status={status} />);
    fireEvent.click(view.getByRole("button", { name: "Turn them on for real" }));
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Go live" }));
    });
    await waitFor(() => expect(view.getByRole("dialog").textContent).toContain("You need admin access on this property to go live."));
  });
});

describe("the platform admin Live switch", () => {
  it("asks before turning a hotel live, and sends nothing until the confirm", async () => {
    const view = render(<SimulationModeToggle hotelId="hotel-1" simulationMode pmsType="think" pmsStatus="connected" windowDays={60} />);

    fireEvent.click(view.getByRole("switch", { name: "Toggle live pricing" }));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(view.getByRole("dialog").textContent).toContain("for the next 60 nights to Think Reservations");

    fireEvent.click(view.getByRole("button", { name: "Not yet" }));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(view.getByRole("switch").getAttribute("aria-checked")).toBe("false");

    fireEvent.click(view.getByRole("switch", { name: "Toggle live pricing" }));
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Go live" }));
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/admin/hotels/hotel-1/simulation");
    expect(JSON.parse(String(init.body))).toEqual({ simulationMode: false });
  });

  it("says nothing is sent for a hotel created without a PMS, or whose connection is gone", () => {
    for (const [pmsType, pmsStatus] of [[null, null], ["cloudbeds", "disconnected"]] as const) {
      const view = render(<SimulationModeToggle hotelId="hotel-1" simulationMode pmsType={pmsType} pmsStatus={pmsStatus} windowDays={60} />);
      fireEvent.click(view.getByRole("switch", { name: "Toggle live pricing" }));
      const dialog = view.getByRole("dialog", { name: "Go live?" });
      expect(dialog.textContent).toContain("No PMS is connected, so nothing is sent until one is.");
      expect(dialog.textContent).not.toContain("MAYA starts sending");
      cleanup();
    }
  });

  it("goes back to simulation at once, with no dialog", async () => {
    const view = render(<SimulationModeToggle hotelId="hotel-1" simulationMode={false} pmsType="cloudbeds" pmsStatus="connected" windowDays={60} />);
    await act(async () => {
      fireEvent.click(view.getByRole("switch", { name: "Toggle live pricing" }));
    });
    expect(view.queryByRole("dialog")).toBeNull();
    expect(JSON.parse(String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({ simulationMode: true });
  });
});
