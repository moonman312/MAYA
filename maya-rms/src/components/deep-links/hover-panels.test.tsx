// @vitest-environment jsdom
/**
 * The hover "?" panels: moving the pointer from the "?" down to Learn more
 * keeps the panel open. The panel sits inside a see-through bridge that starts
 * right under the "?", so there is no gap on the way down that belongs to
 * neither and closes it.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { RoomCountHelp } from "@/components/room-type-settings";
import { RoleHelp } from "@/components/account/role-help";
import { ManualPriceEditor } from "@/components/manual-price-editor";
import { HOVER_BRIDGE } from "./help-links";

afterEach(cleanup);

const cases: { name: string; ui: ReactElement; button: string; panel: string }[] = [
  {
    name: "a room-count style panel",
    ui: <RoomCountHelp label="What counts as a fire" title="What counts as a fire" lines={["One line."]} docs="room-count" />,
    button: "What counts as a fire",
    panel: "What counts as a fire",
  },
  {
    name: "the manual price panel",
    ui: (
      <ManualPriceEditor
        hotelId="hotel-1"
        roomTypeId="rt-1"
        roomTypeName="King"
        stayDate="2026-10-05"
        currentPrice={180}
        pmsName="Cloudbeds"
        onSaved={() => {}}
      />
    ),
    button: "What a manual price does",
    panel: "Setting a price yourself",
  },
  { name: "the roles panel", ui: <RoleHelp />, button: "What each role can do", panel: "What each role can do" },
];

describe("hover ? panels", () => {
  it("the bridge starts flush under the ? and pads rather than leaving a gap", () => {
    const classes = HOVER_BRIDGE.split(" ");
    expect(classes).toContain("top-full");
    expect(classes).toContain("pt-2");
    expect(classes.some((c) => /^(top-\d|mt-)/.test(c))).toBe(false);
  });

  for (const c of cases) {
    it(`${c.name} stays open on the way down to Learn more, and closes once the pointer leaves`, () => {
      render(c.ui);
      const button = screen.getByRole("button", { name: c.button });
      fireEvent.mouseOver(button, { relatedTarget: document.body });
      const panel = screen.getByRole("group", { name: c.panel });

      // The panel is the only thing in the bridge, and carries no offset of its own.
      const bridge = panel.parentElement as HTMLElement;
      expect(bridge.className).toBe(HOVER_BRIDGE);
      expect(panel.className).not.toMatch(/\b(absolute|top-\d+|mt-\d+)\b/);

      // Pointer: "?" -> the bridge's padding -> the panel -> Learn more.
      fireEvent.mouseOut(button, { relatedTarget: bridge });
      fireEvent.mouseOver(bridge, { relatedTarget: button });
      const learnMore = screen.getByRole("link", { name: "Learn more" });
      fireEvent.mouseOut(bridge, { relatedTarget: learnMore });
      fireEvent.mouseOver(learnMore, { relatedTarget: bridge });
      expect(screen.getByRole("group", { name: c.panel })).toBeTruthy();

      // Off the panel altogether: it closes.
      fireEvent.mouseOut(learnMore, { relatedTarget: document.body });
      expect(screen.queryByRole("group", { name: c.panel })).toBeNull();
    });
  }
});
