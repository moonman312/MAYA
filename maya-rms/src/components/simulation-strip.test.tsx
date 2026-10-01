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
import type { PropertyModeView } from "./use-property-mode";

const SIMULATING: PropertyModeView = {
  hotelId: "h-1",
  propertyName: "Juniper Lodge",
  mode: "simulation",
  pmsType: "cloudbeds",
  sendsPrices: true,
  connected: true,
  canGoLive: true,
  windowDays: 396,
};

let fetchSpy: ReturnType<typeof vi.fn>;
function answer(mode: PropertyModeView | null, activate: { status: number; body: unknown } = { status: 200, body: { ok: true } }) {
  fetchSpy = vi.fn(async (url: string) => {
    if (url === "/api/property/mode") {
      return mode ? new Response(JSON.stringify(mode), { status: 200 }) : new Response("{}", { status: 400 });
    }
    if (url === "/api/onboarding/activate") return new Response(JSON.stringify(activate.body), { status: activate.status });
    if (url.startsWith("/api/property/outside-limits")) return new Response(JSON.stringify({ nights: 3 }), { status: 200 });
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
    // The existing confirm, naming the property: nothing is sent to the server yet.
    expect(screen.getByRole("dialog").textContent).toContain("Send Juniper Lodge's prices to Cloudbeds?");
    expect(screen.getByRole("dialog").textContent).toContain("Going live sends MAYA's prices to Cloudbeds automatically.");
    expect(screen.getByRole("dialog").textContent).toContain("for the next 396 nights");
    expect(screen.getByRole("dialog").textContent).toContain("Terms");
    // The nights whose own rate sits outside a floor or ceiling, for this property.
    expect(await screen.findByText("3 nights have a rate outside your floor or ceiling; MAYA will move them inside when it sends.")).toBeTruthy();
    expect(fetchSpy.mock.calls.some(([url]) => url === "/api/property/outside-limits?hotelId=h-1")).toBe(true);
    expect(fetchSpy.mock.calls.some(([url]) => url === "/api/onboarding/activate")).toBe(false);
    fireEvent.click(screen.getAllByRole("button", { name: "Go live" }).at(-1)!);
    await screen.findByTestId("mode-live");
    const call = fetchSpy.mock.calls.find(([url]) => url === "/api/onboarding/activate")!;
    expect(call[1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(call[1].body))).toHaveProperty("termsVersion");
    // The property the strip showed, so the route can refuse if the active one changed.
    expect(JSON.parse(String(call[1].body))).toMatchObject({ hotelId: "h-1" });
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

  it("reads again when the property on screen changes, showing nothing of the last one meanwhile", async () => {
    const onMode = vi.fn();
    const { rerender } = render(<SimulationStrip hotelId="h-1" onMode={onMode} />);
    await screen.findByTestId("mode-simulation");
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    fetchSpy.mockImplementation(async (url: string) => {
      await held;
      return url === "/api/property/mode"
        ? new Response(JSON.stringify({ ...SIMULATING, hotelId: "h-2", mode: "live", canGoLive: false }), { status: 200 })
        : new Response("{}", { status: 500 });
    });
    rerender(<SimulationStrip hotelId="h-2" onMode={onMode} />);
    // While h-2's mode is read, h-1's strip and its Go live are gone.
    expect(screen.queryByTestId("mode-simulation")).toBeNull();
    expect(screen.queryByRole("button", { name: "Go live" })).toBeNull();
    await waitFor(() => expect(onMode).toHaveBeenLastCalledWith(null));
    release();
    await screen.findByTestId("mode-live");
  });

  it("stands out: a stronger amber with a dot, and a Go live big enough to tap", async () => {
    render(<SimulationStrip hotelId="h-1" />);
    const strip = await screen.findByTestId("mode-simulation");
    expect(strip.className).toContain("bg-amber-500/20");
    expect(strip.querySelector(".bg-amber-400.rounded-full")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Go live" }).className).toContain("min-h-7");
  });

  it("sits in the page's own column on the review page", async () => {
    render(<SimulationStrip width="" boxed />);
    const strip = await screen.findByTestId("mode-simulation");
    expect(strip.className).toContain("rounded-md");
  });
});
