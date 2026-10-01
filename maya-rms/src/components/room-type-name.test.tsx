// @vitest-environment jsdom
/**
 * Room types read by their full names wherever an owner picks or reads one:
 * a long name is cut short on screen and whole on hover, and two types whose
 * short codes match stay told apart.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RoomTypeName } from "./room-type-name";
import { RuleRoomTypesField } from "./rule-room-types-field";

afterEach(cleanup);

describe("a room type's name on screen", () => {
  it("is the whole name, truncated visually, with the whole name on hover", () => {
    render(<RoomTypeName name="Harbour Double Deluxe with Lighthouse View Balcony" className="max-w-[10rem]" />);
    const el = screen.getByText("Harbour Double Deluxe with Lighthouse View Balcony");
    expect(el.getAttribute("title")).toBe("Harbour Double Deluxe with Lighthouse View Balcony");
    expect(el.className).toContain("truncate");
    expect(el.className).toContain("max-w-[10rem]");
  });

  it("tells two types that share a short code apart in the rule builder's picker", () => {
    render(
      <RuleRoomTypesField
        options={[
          { id: "a", name: "Harbour Double", counts_as_room: true },
          { id: "b", name: "Harbour Double Deluxe", counts_as_room: true },
        ]}
        selected={["a"]}
        onSelected={() => {}}
        split={false}
        onSplit={() => {}}
        changeIds={[]}
        onChangeIds={() => {}}
      />,
    );
    const double = screen.getByRole("button", { name: "Harbour Double" });
    const deluxe = screen.getByRole("button", { name: "Harbour Double Deluxe" });
    expect(double.getAttribute("title")).toBe("Harbour Double");
    expect(deluxe.getAttribute("title")).toBe("Harbour Double Deluxe");
    expect(deluxe.querySelector("span")?.className).toContain("truncate");
  });
});
