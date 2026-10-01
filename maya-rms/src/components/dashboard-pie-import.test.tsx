// @vitest-environment jsdom
/**
 * Import from PIE on the Rules tab: the small link (Cloudbeds properties
 * only), the import opening from a link into it, a rule opened in the rule
 * builder and brought back changed, and the rules added through the one
 * popup. The browser's OCR is stood in for (its own tests run it); every
 * name and number is made up.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PieRowRead, ScreenshotRead } from "@/lib/pie-import/read";

const SHOT: ScreenshotRead = {
  width: 2000,
  height: 1200,
  columns: null,
  rows: [
    {
      name: "Busy weekends",
      description: "Raise rate by 10.00 % when occupancy is greater than 60.00 % and when booking 30-500 days in advance",
      mode: "auto",
      type: "occupancy",
      typeText: "Occupancy",
      active: true,
      startDate: "N/A",
      endDate: "N/A",
      cutOff: false,
    cutEdge: null,
    numbersUnsure: false,
      y: 0,
    } satisfies PieRowRead,
  ],
  limits: { master: null, byType: [] },
  entries: null,
  rulesSeen: true,
  scale: 2,
};

vi.mock("@/lib/pie-import/browser-ocr", () => ({
  startScreenshotReader: async () => ({ open: async () => ({ image: { width: 1, height: 1, data: new Uint8Array(4) }, pass: async () => [] }), close: async () => {} }),
}));
vi.mock("@/lib/pie-import/read", async (orig) => ({ ...(await orig<typeof import("@/lib/pie-import/read")>()), readScreenshot: async () => SHOT }));

const { Dashboard } = await import("./dashboard");

const STD = "11111111-1111-4111-8111-111111111111";
const SUITE = "22222222-2222-4222-8222-222222222222";
const ROOM_TYPES = [
  { id: STD, name: "Standard", counts_as_room: true, floor_price: 90, ceiling_price: 400 },
  { id: SUITE, name: "Suite", counts_as_room: true, floor_price: 150, ceiling_price: 700 },
];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

type Sent = { url: string; method: string; body: Record<string, unknown> | null };
let sent: Sent[] = [];
let pmsType = "cloudbeds";

beforeEach(() => {
  sent = [];
  pmsType = "cloudbeds";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      if (method !== "GET" && url !== "/api/events") sent.push({ url, method, body });
      if (url === "/api/rules" && method === "GET") return json([]);
      if (url === "/api/rules/fire-counts") return json({});
      if (url === "/api/rules/stops") return json([]);
      if (url === "/api/room-types") return json(ROOM_TYPES);
      if (url === "/api/hotels") return json({ hotels: [{ id: "h1", name: "Cliff House" }], activeHotelId: "h1" });
      if (url === "/api/pms/activity")
        return json({ connection: { pms_type: pmsType, status: "connected", last_sync_at: null, last_tested_at: null }, pms: null, health: { state: "unknown", successRate: null, total: 0, failures: 0 }, log: [] });
      if (url === "/api/rules/preview")
        return json({ needsActivation: true, today: "2026-10-01", lastNight: "2027-10-31", affected: ["2026-11-03"], roomTypesChanged: { "2026-11-03": 2 }, touched: ["2026-11-03"], fingerprint: "fp", kind: "standard", ms: 5, nightsChecked: 2 });
      if (url === "/api/rules/import") return json({ created: [{ id: "x", on: true }], failed: [], limits: 0, skipped: false });
      if (url === "/api/events") return new Response(null, { status: 204 });
      return json({}, 404);
    }),
  );
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => setTimeout(cb, 0));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

async function rulesTab(search = "?tab=rules") {
  window.history.replaceState(null, "", `/${search}`);
  render(<Dashboard initialSearch={window.location.search} />);
  await screen.findByText("Pricing Rules");
}

const file = () => new File(["png"], "pie.png", { type: "image/png" });

describe("Import from PIE on the Rules tab", () => {
  it("shows the link for a Cloudbeds property and opens the import on its place", async () => {
    await rulesTab();
    fireEvent.click(await screen.findByRole("button", { name: "Import from PIE" }));
    expect(await screen.findByRole("dialog", { name: "Import from PIE" })).toBeTruthy();
    expect(window.location.search).toContain("panel=import-pie");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Import from PIE" })).toBeNull());
    expect(window.location.search).not.toContain("panel=import-pie");
  });

  it("has no link for another system", async () => {
    pmsType = "thinkreservations";
    await rulesTab();
    await waitFor(() => expect(sent).toEqual([]));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("button", { name: "Import from PIE" })).toBeNull();
  });

  it("opens from a link into it, sends a rule to the builder and back, and adds it through the popup", async () => {
    await rulesTab("?tab=rules&panel=import-pie");
    const dialog = await screen.findByRole("dialog", { name: "Import from PIE" });
    fireEvent.change(within(dialog).getByTestId("pie-file"), { target: { files: [file()] } });
    await within(dialog).findByTestId("pie-rules");
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit" }));

    // The builder, filled with the rule; the import out of sight meanwhile.
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Import from PIE" })).toBeNull());
    expect(screen.getByText("Change before importing")).toBeTruthy();
    expect((screen.getByPlaceholderText("e.g. Weekend surge") as HTMLInputElement).value).toBe("Busy weekends");
    fireEvent.change(screen.getByLabelText("Adjust by percent (%)"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Use in the import" }));

    const back = await screen.findByRole("dialog", { name: "Import from PIE" });
    expect(within(back).getByText("Raise the price 12% when sellable occupancy is over 60%, 30 or more days before arrival.")).toBeTruthy();
    // Nothing saved by the builder.
    expect(sent.filter((s) => s.url === "/api/rules")).toEqual([]);

    fireEvent.click(within(back).getByRole("button", { name: "Add 1 rule" }));
    const popup = await screen.findByRole("dialog", { name: "Add 1 rule from PIE?" });
    await waitFor(() => expect(within(popup).getByTestId("activation-summary").textContent).toBe("1 day will be affected by these rules."));
    fireEvent.click(within(popup).getByRole("button", { name: "Apply price adjustments" }));
    expect(await screen.findByTestId("pie-done")).toBeTruthy();
    const saved = sent.find((s) => s.url === "/api/rules/import")!.body!;
    expect((saved.rules as { rule_name: string; action: unknown; on: boolean }[]).map((r) => [r.rule_name, r.action, r.on])).toEqual([
      ["Busy weekends", { adjust_rate_percent: 12 }, true],
    ]);
  });
});
