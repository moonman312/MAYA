// @vitest-environment jsdom
/**
 * The strip at the top of every property screen: amber while simulating,
 * with Go live for a General Manager or Hotel Admin (through the same confirm
 * and the same call as the review card), who can switch it for everyone else,
 * and a small green "Live" tag once live.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SimulationStrip } from "./simulation-strip";
import type { PropertyMode } from "@/lib/simulation-strip";

const SIMULATING: PropertyMode = {
  mode: "simulation",
  pmsType: "cloudbeds",
  sendsPrices: true,
  connected: true,
  canGoLive: true,
  windowDays: 396,
};

let fetchSpy: ReturnType<typeof vi.fn>;
function answer(mode: PropertyMode | null, activate: { status: number; body: unknown } = { status: 200, body: { ok: true } }) {
  fetchSpy = vi.fn(async (url: string) => {
    if (url === "/api/property/mode") {
      return mode ? new Response(JSON.stringify(mode), { status: 200 }) : new Response("{}", { status: 400 });
    }
    if (url === "/api/onboarding/activate") return new Response(JSON.stringify(activate.body), { status: activate.status });
    throw new Error(`unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchSpy);
}

beforeEach(() => answer(SIMULATING));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SimulationStrip", () => {
  it("says the property is simulating and that nothing goes to the system", async () => {
    render(<SimulationStrip hotelId="h-1" />);
    const strip = await screen.findByTestId("mode-simulation");
    expect(strip.textContent).toContain("Simulation · MAYA works out prices but sends nothing to Cloudbeds");
    expect(strip.getAttribute("role")).toBe("status");
  });

  it("lets a General Manager go live through the same confirm, then shows Live", async () => {
    const onWentLive = vi.fn();
    render(<SimulationStrip hotelId="h-1" onWentLive={onWentLive} />);
    fireEvent.click(await screen.findByRole("button", { name: "Go live" }));
    // The existing confirm: nothing is sent to the server yet.
    expect(screen.getByRole("dialog").textContent).toContain("Send prices to Cloudbeds?");
    expect(screen.getByRole("dialog").textContent).toContain("for the next 396 nights");
    expect(screen.getByRole("dialog").textContent).toContain("Terms");
    expect(fetchSpy.mock.calls.some(([url]) => url === "/api/onboarding/activate")).toBe(false);
    fireEvent.click(screen.getAllByRole("button", { name: "Go live" }).at(-1)!);
    await screen.findByTestId("mode-live");
    const call = fetchSpy.mock.calls.find(([url]) => url === "/api/onboarding/activate")!;
    expect(call[1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(call[1].body))).toHaveProperty("termsVersion");
    expect(onWentLive).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the confirm open with the reason when the switch is refused", async () => {
    answer(SIMULATING, { status: 403, body: { error: "You need admin access on this property to go live." } });
    render(<SimulationStrip />);
    fireEvent.click(await screen.findByRole("button", { name: "Go live" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Go live" }).at(-1)!);
    await waitFor(() => expect(screen.getByRole("dialog").textContent).toContain("You need admin access on this property to go live."));
    expect(screen.queryByTestId("mode-live")).toBeNull();
  });

  it("offers no Go live to anyone else, and says who can behind the ?", async () => {
    answer({ ...SIMULATING, canGoLive: false });
    render(<SimulationStrip />);
    await screen.findByTestId("mode-simulation");
    expect(screen.queryByRole("button", { name: "Go live" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "What simulation means" }));
    expect(document.body.textContent).toContain("A General Manager or Hotel Admin can switch this property to live.");
  });

  it("offers no Go live on a system MAYA doesn't send prices to", async () => {
    answer({ ...SIMULATING, pmsType: "mews", sendsPrices: false, canGoLive: false });
    render(<SimulationStrip />);
    const strip = await screen.findByTestId("mode-simulation");
    expect(strip.textContent).toContain("sends nothing to Mews");
    expect(screen.queryByRole("button", { name: "Go live" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "What simulation means" }));
    expect(document.body.textContent).toContain("MAYA doesn't send prices to Mews yet, so there is nothing to switch on here.");
  });

  it("shows a small Live tag and no strip on a live property", async () => {
    answer({ ...SIMULATING, mode: "live", canGoLive: false });
    render(<SimulationStrip />);
    const tag = await screen.findByTestId("mode-live");
    expect(tag.textContent).toBe("Live");
    expect(tag.querySelector("[title]")?.getAttribute("title")).toBe("MAYA sends its prices to Cloudbeds.");
    expect(screen.queryByTestId("mode-simulation")).toBeNull();
  });

  it("shows nothing when the mode can't be read", async () => {
    answer(null);
    const { container } = render(<SimulationStrip />);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("reads again when the property on screen changes", async () => {
    const { rerender } = render(<SimulationStrip hotelId="h-1" />);
    await screen.findByTestId("mode-simulation");
    answer({ ...SIMULATING, mode: "live", canGoLive: false });
    rerender(<SimulationStrip hotelId="h-2" />);
    await screen.findByTestId("mode-live");
  });
});
