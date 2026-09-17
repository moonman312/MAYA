// @vitest-environment jsdom
/**
 * The builder's room types: one list unless the owner asks to change prices
 * on different room types, and the sets each mode sends.
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ruleRoomTypeSets, type RoomTypeOption } from "@/lib/rule-form";
import { RuleRoomTypesField } from "./rule-room-types-field";

afterEach(cleanup);

const OPTIONS: RoomTypeOption[] = [
  { id: "std", name: "Standard", counts_as_room: true },
  { id: "dlx", name: "Deluxe", counts_as_room: null },
  { id: "ph", name: "Penthouse", counts_as_room: true },
  { id: "court", name: "Court", counts_as_room: false },
];

let last: { selected: string[]; split: boolean; changeIds: string[] } = { selected: [], split: false, changeIds: [] };

function Harness({ initial }: { initial: string[] }) {
  const [selected, setSelected] = useState(initial);
  const [split, setSplit] = useState(false);
  const [changeIds, setChangeIds] = useState<string[]>([]);
  useEffect(() => {
    last = { selected, split, changeIds };
  });
  return (
    <RuleRoomTypesField
      options={OPTIONS}
      selected={selected}
      onSelected={setSelected}
      split={split}
      onSplit={setSplit}
      changeIds={changeIds}
      onChangeIds={setChangeIds}
    />
  );
}

const chip = (root: HTMLElement, section: string, name: string) => {
  const heading = [...root.querySelectorAll("p")].find((p) => p.textContent === section)!;
  const block = heading.closest("div")!.parentElement!;
  return [...block.querySelectorAll("button")].find((b) => b.textContent?.startsWith(name))!;
};

describe("RuleRoomTypesField", () => {
  it("shows one list by default and splits into Measure and Change on the checkbox", () => {
    const view = render(<Harness initial={["std", "dlx"]} />);
    const text = () => view.container.textContent ?? "";
    expect(text()).toContain("Apply to room types");
    expect(text()).not.toContain("Measure");

    fireEvent.click(view.getByLabelText("Change prices on different room types"));
    expect(text()).toContain("Measure");
    expect(text()).toContain("Change");
    expect(text()).not.toContain("Apply to room types");
    // Change starts as a copy of the first list.
    expect(last.changeIds).toEqual(["std", "dlx"]);
    // Non-rooms are never measured, so the Measure list does not offer them.
    expect(chip(view.container, "Measure", "Court")).toBeUndefined();
    expect(chip(view.container, "Change", "Court")).toBeDefined();

    fireEvent.click(chip(view.container, "Change", "Standard"));
    fireEvent.click(chip(view.container, "Change", "Deluxe"));
    fireEvent.click(chip(view.container, "Change", "Penthouse"));
    expect(last.changeIds).toEqual(["ph"]);
    expect(last.selected).toEqual(["std", "dlx"]);

    fireEvent.click(view.getByLabelText("Change prices on different room types"));
    expect(text()).toContain("Apply to room types");
    expect(last.split).toBe(false);
    expect(last.selected).toEqual(["std", "dlx"]);
    expect(text()).not.toMatch(/—/);
  });
});

describe("ruleRoomTypeSets", () => {
  it("one list: changes the picked types and measures the counting ones, as the server defaults", () => {
    expect(ruleRoomTypeSets({ options: OPTIONS, selected: ["std", "court"], split: false, changeIds: [] })).toEqual({
      signal_room_type_ids: ["std"],
      affected_room_type_ids: ["std", "court"],
      room_types: ["Standard", "Court"],
    });
    // Only the court: it is measured on its own numbers, as createRule does.
    expect(ruleRoomTypeSets({ options: OPTIONS, selected: ["court"], split: false, changeIds: [] })).toMatchObject({
      signal_room_type_ids: ["court"],
      affected_room_type_ids: ["court"],
    });
    expect(ruleRoomTypeSets({ options: OPTIONS, selected: [], split: false, changeIds: [] })).toEqual({
      error: "Select at least one room type.",
    });
  });

  it("split: measures the first list and changes the second", () => {
    expect(ruleRoomTypeSets({ options: OPTIONS, selected: ["std", "dlx"], split: true, changeIds: ["ph"] })).toEqual({
      signal_room_type_ids: ["std", "dlx"],
      affected_room_type_ids: ["ph"],
      room_types: ["Penthouse"],
    });
    expect(ruleRoomTypeSets({ options: OPTIONS, selected: [], split: true, changeIds: ["ph"] })).toEqual({
      error: "Pick at least one room type to measure.",
    });
    expect(ruleRoomTypeSets({ options: OPTIONS, selected: ["court"], split: true, changeIds: ["ph"] })).toEqual({
      error: "Pick at least one room type to measure.",
    });
    expect(ruleRoomTypeSets({ options: OPTIONS, selected: ["std"], split: true, changeIds: [] })).toEqual({
      error: "Pick at least one room type to change.",
    });
  });
});
