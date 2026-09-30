// @vitest-environment jsdom
/**
 * The change log's items about rates changed in the property system: an
 * overwrite reads as one line, and the warning that something else seems to
 * be changing rates carries the one button that opens the setting in
 * Settings.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangelogPmsChange } from "@/types/domain";
import { Dashboard } from "./dashboard";
import { PmsChangeItem } from "./pms-change-item";

const warning: ChangelogPmsChange = {
  kind: "pms_change",
  id: "w1",
  timestamp: "2026-10-05T10:00:00Z",
  change: "other_tool",
  pms: "Cloudbeds",
  title: "Something other than MAYA seems to be changing rates in Cloudbeds: 21 rates changed in the last 7 days.",
  count: 21,
};
const overwrite: ChangelogPmsChange = {
  kind: "pms_change",
  id: "o1",
  timestamp: "2026-10-05T09:00:00Z",
  change: "overwrite",
  pms: "Cloudbeds",
  title: "Fri, Nov 13, Standard: changed in Cloudbeds to $175.00. MAYA sent its price, $165.00, again.",
  stay_date: "2026-11-13",
  room_type: "Standard",
  pms_rate: 175,
  maya_price: 165,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const item = (i: ChangelogPmsChange, onOpenSetting = vi.fn()) =>
  render(
    <PmsChangeItem item={i} formatWhen={() => "Oct 5, 10:00"} formatAge={() => "1 day ago"} formatExact={() => "exact"} onOpenSetting={onOpenSetting} />,
  );

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("PmsChangeItem", () => {
  it("reads an overwrite as one line under Changed in Cloudbeds, with nothing to press", () => {
    item(overwrite);
    expect(screen.getByText("Changed in Cloudbeds")).toBeTruthy();
    expect(screen.getByText(overwrite.title)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("gives the warning a button that opens the setting, until the setting is on", () => {
    const onOpenSetting = vi.fn();
    item(warning, onOpenSetting);
    fireEvent.click(screen.getByRole("button", { name: "Open the setting" }));
    expect(onOpenSetting).toHaveBeenCalledTimes(1);
    cleanup();
    item({ ...warning, setting_on: true });
    expect(screen.queryByRole("button", { name: "Open the setting" })).toBeNull();
  });
});

describe("in the Change Log", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/changelog") return json([warning, overwrite]);
        if (url === "/api/settings") {
          return json({
            property: { canEdit: true, readOnly: null },
            calendar: { big: "occupancy", small: ["rooms_booked", "room_revenue"], price_room_type_id: null, colors: "standard" },
            pms: { type: "cloudbeds", name: "Cloudbeds", mode: "keep" },
            textSize: "standard",
          });
        }
        if (url === "/api/rules" || url === "/api/rules/stops" || url === "/api/room-types") return json([]);
        if (url === "/api/rules/fire-counts") return json({});
        if (url === "/api/hotels") return json({ hotels: [], activeHotelId: null });
        if (url.startsWith("/api/calendar/")) return json({ error: "not in this test" }, 404);
        return new Response(null, { status: 204 });
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("opens Settings at the property system's section from the warning's button, and shows with Show Changes Only", async () => {
    window.history.replaceState(null, "", "/?tab=changelog");
    await act(async () => {
      render(<Dashboard initialSearch={window.location.search} />);
    });
    expect(await screen.findByText(overwrite.title)).toBeTruthy();
    // Shown whichever way the list is filtered.
    for (let i = 0; i < 2; i++) {
      fireEvent.click(screen.getByRole("button", { name: /^Show (All Cycles|Changes Only)$/ }));
      expect(screen.getByText(overwrite.title)).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("button", { name: "Open the setting" }));
    expect(await screen.findByRole("dialog", { name: "Settings" })).toBeTruthy();
    expect(await screen.findByRole("region", { name: "Cloudbeds" })).toBeTruthy();
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
  });
});
