// @vitest-environment jsdom
/**
 * Every switch that turns a hotel live asks first, and nothing reaches the
 * server until the confirm. What the dialog says has to be what the push does.
 */
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoLiveConfirmation, GoLiveDialog, OutsideLimitsLine, WENT_LIVE_EVENT, goLiveCopy, outsideLimitsLine, pmsConnected, requestGoLive } from "./go-live-dialog";
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

describe("the nights whose own rate sits outside a limit (audit A21)", () => {
  it("counts them in plain words, with no line when there are none", () => {
    expect(outsideLimitsLine(12)).toBe(
      "12 nights have a rate outside your floor or ceiling; MAYA will move them inside when it sends.",
    );
    expect(outsideLimitsLine(1)).toBe("1 night has a rate outside your floor or ceiling; MAYA will move it inside when it sends.");
    expect(outsideLimitsLine(1200)).toContain("1,200 nights");
    for (const none of [0, null, undefined, Number.NaN, -3]) expect(outsideLimitsLine(none)).toBeNull();
    expect(outsideLimitsLine(12)).not.toMatch(/[—–]/);
  });

  it("asks for the property on screen, and shows the count it gets back", async () => {
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ nights: 12 }), { status: 200 }));
    const view = render(<OutsideLimitsLine hotelId="hotel-1" pmsType="cloudbeds" connected />);
    expect(await view.findByText(/12 nights have a rate outside your floor or ceiling/)).toBeTruthy();
    expect(fetchSpy.mock.calls[0][0]).toBe("/api/property/outside-limits?hotelId=hotel-1");
  });

  it("says nothing, and asks nothing, where MAYA sends no price or nothing is connected", async () => {
    for (const props of [{ pmsType: "mews" }, { pmsType: "cloudbeds", connected: false }]) {
      const view = render(<OutsideLimitsLine hotelId="hotel-1" {...props} />);
      expect(view.container.textContent).toBe("");
      cleanup();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("says nothing when the count can't be had", async () => {
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ nights: null }), { status: 200 }));
    const view = render(<OutsideLimitsLine hotelId="hotel-1" pmsType="think" />);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(view.container.textContent).toBe("");
  });
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
      lines: ["MAYA doesn't send prices to Mews yet, so nothing is sent. The hotel only shows as live."],
    });
  });

  it("says nothing is sent yet to a system whose sending is still off, as ThinkReservations' starts (audit A25)", () => {
    expect(goLiveCopy({ pmsType: "think", windowDays: 60, propertyName: "Harbour Inn", sendingOn: false })).toEqual({
      title: "Take Harbour Inn live?",
      lines: [
        "Sending to Think Reservations isn't on yet, so nothing is sent until MAYA switches it on. Your prices wait until then.",
        "Once it's on, each price MAYA sends replaces that night's rate in Think Reservations, and a night is sent again whenever its price changes.",
      ],
    });
    expect(text(goLiveCopy({ pmsType: "think", windowDays: 60, sendingOn: false }))).not.toContain("on the next cycle");
    // Switched on, or a system with no switch to speak of: as before.
    expect(text(goLiveCopy({ pmsType: "think", windowDays: 60, sendingOn: true }))).toContain("MAYA starts sending its prices");
    expect(goLiveCopy({ pmsType: "mews", windowDays: 60, sendingOn: false }).lines[0]).toContain("MAYA doesn't send prices to Mews yet");
    expect(text(goLiveCopy({ pmsType: null, windowDays: 60, sendingOn: false }))).toContain("MAYA starts sending its prices for the next 60 nights to your PMS");
  });

  it("names the property it takes live", () => {
    expect(goLiveCopy({ pmsType: "cloudbeds", windowDays: 60, propertyName: "Juniper Lodge" }).title).toBe(
      "Send Juniper Lodge's prices to Cloudbeds?",
    );
    expect(goLiveCopy({ pmsType: null, windowDays: 60, connected: false, propertyName: "Juniper Lodge" }).title).toBe(
      "Take Juniper Lodge live?",
    );
    expect(goLiveCopy({ pmsType: "cloudbeds", windowDays: 60, propertyName: "  " }).title).toBe("Send prices to Cloudbeds?");
  });
});

describe("GoLiveConfirmation", () => {
  it("says MAYA's prices go to the property system by name, not 'these rates' to 'your PMS'", () => {
    const view = render(<GoLiveConfirmation pmsType="cloudbeds" />);
    expect(view.container.textContent).toBe(
      "Going live sends MAYA's prices to Cloudbeds automatically. You're confirming you've reviewed your rules and limits (Terms 3.3).",
    );
    view.unmount();
    expect(render(<GoLiveConfirmation />).container.textContent).toContain("sends MAYA's prices to your property system automatically");
  });

  it("says the prices go once sending is on, where it is still off", () => {
    expect(render(<GoLiveConfirmation pmsType="think" sendingOn={false} />).container.textContent).toBe(
      "Going live sends MAYA's prices to Think Reservations automatically once sending is on. You're confirming you've reviewed your rules and limits (Terms 3.3).",
    );
  });
});

describe("requestGoLive", () => {
  it("sends the property the page shows, and tells the page once it went live", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const heard = vi.fn();
    window.addEventListener(WENT_LIVE_EVENT, heard);
    expect(await requestGoLive("hotel-juniper")).toBeNull();
    window.removeEventListener(WENT_LIVE_EVENT, heard);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ hotelId: "hotel-juniper" });
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("gives the route's reason when it refuses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "This page is for another property. Reload and try again." }), { status: 409 })));
    expect(await requestGoLive("hotel-juniper")).toBe("This page is for another property. Reload and try again.");
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
    hotelId: "hotel-1",
    hotelName: "Juniper Lodge",
    simulationMode: true,
    pmsType: "cloudbeds",
    pushWindowDays: 60,
    job: { stats: { starterRules: [{ name: "Busy nights", explanation: "Raises busy nights." }] } },
  } as unknown as Parameters<typeof StarterRules>[0]["status"];

  const modeAnswer = (over: Record<string, unknown> = {}) => ({
    hotelId: "hotel-1",
    propertyName: "Juniper Lodge",
    mode: "simulation",
    pmsType: "cloudbeds",
    sendsPrices: true,
    connected: true,
    canGoLive: true,
    windowDays: 60,
    ...over,
  });
  const answer = (mode: Record<string, unknown>, activate?: Response, outside: number | null = null) =>
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) =>
      String(input) === "/api/property/mode"
        ? new Response(JSON.stringify(mode), { status: 200 })
        : String(input).startsWith("/api/property/outside-limits")
          ? new Response(JSON.stringify({ nights: outside }), { status: 200 })
          : (activate ?? new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
  const activateCalls = () => fetchSpy.mock.calls.filter((c) => c[0] === "/api/onboarding/activate");

  it("asks before it calls the server, and goes live only on the confirm", async () => {
    answer(modeAnswer());
    const view = render(<StarterRules status={status} />);

    fireEvent.click(await view.findByRole("button", { name: "Turn them on for real" }));
    expect(activateCalls()).toHaveLength(0);
    const dialog = view.getByRole("dialog", { name: "Send Juniper Lodge's prices to Cloudbeds?" });
    expect(dialog.textContent).toContain("MAYA starts sending its prices for the next 60 nights to Cloudbeds");
    // The Terms line sits with the press it describes.
    expect(dialog.textContent).toContain("You're confirming you've reviewed your rules and limits");

    fireEvent.click(view.getByRole("button", { name: "Not yet" }));
    expect(view.queryByRole("dialog")).toBeNull();
    expect(activateCalls()).toHaveLength(0);

    fireEvent.click(view.getByRole("button", { name: "Turn them on for real" }));
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Go live" }));
    });
    expect(activateCalls()).toHaveLength(1);
    // For the property this page shows.
    expect(JSON.parse(String((activateCalls()[0][1] as RequestInit).body))).toMatchObject({ hotelId: "hotel-1" });
    await waitFor(() => expect(view.container.textContent).toContain("Live: your rules are now managing prices"));
    expect(view.queryByRole("dialog")).toBeNull();
  });

  it("counts in the confirm the nights whose own rate sits outside a floor or ceiling", async () => {
    answer(modeAnswer(), undefined, 12);
    const view = render(<StarterRules status={status} />);
    fireEvent.click(await view.findByRole("button", { name: "Turn them on for real" }));
    await waitFor(() =>
      expect(view.getByRole("dialog").textContent).toContain(
        "12 nights have a rate outside your floor or ceiling; MAYA will move them inside when it sends.",
      ),
    );
    expect(fetchSpy.mock.calls.some((c) => c[0] === "/api/property/outside-limits?hotelId=hotel-1")).toBe(true);
  });

  it("says on a ThinkReservations property whose sending is off that nothing is sent yet", async () => {
    answer(modeAnswer({ pmsType: "think", sendingOn: false }));
    const view = render(<StarterRules status={{ ...status!, pmsType: "think" }} />);
    fireEvent.click(await view.findByRole("button", { name: "Turn them on for real" }));
    const dialog = view.getByRole("dialog", { name: "Take Juniper Lodge live?" });
    expect(dialog.textContent).toContain("Sending to Think Reservations isn't on yet, so nothing is sent until MAYA switches it on.");
    expect(dialog.textContent).toContain("to Think Reservations automatically once sending is on.");
    expect(dialog.textContent).not.toContain("on the next cycle");
  });

  it("keeps the dialog open with the server's reason when going live fails", async () => {
    answer(modeAnswer(), new Response(JSON.stringify({ error: "You need admin access on this property to go live." }), { status: 403 }));
    const view = render(<StarterRules status={status} />);
    fireEvent.click(await view.findByRole("button", { name: "Turn them on for real" }));
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Go live" }));
    });
    await waitFor(() => expect(view.getByRole("dialog").textContent).toContain("You need admin access on this property to go live."));
  });

  it("offers it on the strip's terms: who can, for everyone else, and nothing to switch on for Mews", async () => {
    answer(modeAnswer({ canGoLive: false }));
    let view = render(<StarterRules status={status} />);
    expect(await view.findByText("A General Manager or Hotel Admin can switch this property to live.")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Turn them on for real" })).toBeNull();
    cleanup();

    answer(modeAnswer({ pmsType: "mews", sendsPrices: false, canGoLive: false }));
    view = render(<StarterRules status={{ ...status!, pmsType: "mews" }} />);
    expect(await view.findByText("MAYA doesn't send prices to Mews yet, so there is nothing to switch on here.")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Turn them on for real" })).toBeNull();
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
