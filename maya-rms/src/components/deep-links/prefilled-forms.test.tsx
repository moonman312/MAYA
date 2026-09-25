// @vitest-environment jsdom
/**
 * The other forms a link can fill in: the Rate Simulator's test rule and the
 * Team invite. Filled, shown with the chip, and never sent.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RateSimulator } from "@/components/rate-simulator";
import { TeamManager } from "@/components/account/team-manager";
import { links } from "@/lib/deep-links";
import { testRuleFill } from "@/lib/deep-links/prefill";

let calls: { url: string; method: string }[] = [];
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: (init?.method ?? "GET").toUpperCase() });
      if (url.startsWith("/api/room-types")) {
        return json({ timezone: "America/Los_Angeles", roomTypes: [{ id: "rt-1", name: "Standard", total_rooms: 12, floor_price: 1, ceiling_price: 99999, seed_rate: 150 }] });
      }
      if (url === "/api/rules/engine") return json([]);
      if (url === "/api/account/team") {
        return json({ members: [], invites: [], seats: { used: 1, limit: 5, remaining: 4, full: false }, rooms: 20 });
      }
      return new Response(null, { status: 204 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const writes = () => calls.filter((c) => c.method !== "GET");

describe("the Rate Simulator's test rule from a link", () => {
  it("opens filled in, on the night the link asked for, and saves nothing", async () => {
    const fill = testRuleFill(links.parseLink("simulator.test-rule", "name=Last+minute&window=lt3&occupancy=lt50&direction=decrease&percent=15&stay_in=1").params);
    render(<RateSimulator activeHotelId="h1" initialDraft={fill} />);
    const name = (await screen.findByLabelText("Rule name")) as HTMLInputElement;
    expect(name.value).toBe("Last minute");
    expect(screen.getByText("Filled in from a link")).toBeTruthy();
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const tomorrow = new Date(`${today}T00:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    await waitFor(() => expect((screen.getByLabelText("Stay date") as HTMLInputElement).value).toBe(tomorrow.toISOString().slice(0, 10)));
    expect(writes()).toEqual([]);
  });
});

describe("the Team invite from a link", () => {
  it("picks the role, leaves the email empty, and sends nothing", async () => {
    render(<TeamManager initialInviteRole="viewer" />);
    const role = (await screen.findByLabelText("What they can do")) as HTMLSelectElement;
    expect(role.value).toBe("viewer");
    expect((screen.getByLabelText("Their email") as HTMLInputElement).value).toBe("");
    expect(screen.getByText("Filled in from a link")).toBeTruthy();
    expect(writes()).toEqual([]);
  });

  it("ignores a role that is not one of MAYA's", async () => {
    render(<TeamManager initialInviteRole="owner" />);
    expect(((await screen.findByLabelText("What they can do")) as HTMLSelectElement).value).toBe("revenue_manager");
    expect(screen.queryByText("Filled in from a link")).toBeNull();
  });
});
