// @vitest-environment jsdom
/**
 * The rule builder's "Then waits (advanced)" for a pickup count condition:
 * it starts on the lookback window, a choice goes into the row the form
 * saves, and a rule whose booking speed wait is longer says so.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  conditionRowsToRuleCondition,
  newConditionRow,
  pickupCountsLow,
  ruleConditionForInsert,
  type BookingSpeedWaitDays,
  type ConditionFormRow,
} from "@/lib/rule-form";
import { PickupWaitField } from "./pickup-wait-field";

afterEach(cleanup);

/** The builder's row state, as dashboard.tsx keeps it, with the field wired the same way. */
function Builder({
  onRow,
  speedWait,
  operator = "gt",
}: {
  onRow: (row: ConditionFormRow) => void;
  speedWait?: BookingSpeedWaitDays;
  operator?: "gt" | "lt";
}) {
  const [row, setRow] = useState(() => newConditionRow("pickup", { value: "5", pickup_window_days: 7, operator }));
  onRow(row);
  return (
    <PickupWaitField
      id="pickup-wait-1"
      value={row.pickup_cooldown_days}
      windowDays={row.pickup_window_days}
      lowPickup={pickupCountsLow(row.operator, Number(row.value))}
      bookingSpeedCooldownDays={speedWait}
      onChange={(days) => setRow((r) => ({ ...r, pickup_cooldown_days: days }))}
    />
  );
}

const optionTexts = () => Array.from(screen.getByLabelText("Then waits (advanced)").querySelectorAll("option")).map((o) => o.textContent);

describe("PickupWaitField", () => {
  it("starts on the lookback window and offers the waits a booking speed rule gets", () => {
    let row!: ConditionFormRow;
    render(<Builder onRow={(r) => (row = r)} />);
    const select = screen.getByLabelText("Then waits (advanced)") as HTMLSelectElement;
    expect(select.value).toBe("same");
    expect(optionTexts()).toEqual(["Same as the lookback window", "1 day", "2 days", "3 days", "1 week", "2 weeks"]);
    expect(row.pickup_cooldown_days).toBeNull();
  });

  it("round-trips a choice into the condition the form saves, and back to the window as nothing", () => {
    let row!: ConditionFormRow;
    render(<Builder onRow={(r) => (row = r)} />);
    const select = screen.getByLabelText("Then waits (advanced)") as HTMLSelectElement;

    fireEvent.change(select, { target: { value: "2" } });
    expect(select.value).toBe("2");
    expect(row.pickup_cooldown_days).toBe(2);
    expect(ruleConditionForInsert(conditionRowsToRuleCondition([row]))).toEqual({
      pickup_operator: "gt",
      pickup_threshold: 5,
      pickup_window_days: 7,
      pickup_metric: "room_nights",
      pickup_cooldown_days: 2,
    });

    fireEvent.change(select, { target: { value: "same" } });
    expect(row.pickup_cooldown_days).toBeNull();
    expect(ruleConditionForInsert(conditionRowsToRuleCondition([row]))).not.toHaveProperty("pickup_cooldown_days");
  });

  it("says which choices the rule's longer booking speed wait holds, and the ? names the wait it keeps", () => {
    render(<Builder onRow={() => {}} speedWait={3} />);
    expect(optionTexts()).toEqual([
      "Same as the lookback window",
      "1 day (booking speed holds it to 3 days)",
      "2 days (booking speed holds it to 3 days)",
      "3 days",
      "1 week",
      "2 weeks",
    ]);
    fireEvent.change(screen.getByLabelText("Then waits (advanced)"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "How the wait works" }));
    const panel = screen.getByRole("tooltip").textContent ?? "";
    expect(panel).toContain("After this rule adjusts a night, it leaves that night alone for 3 days.");
    expect(panel).toContain("Its booking speed condition waits 3 days, which is longer, so that is what it waits.");
  });

  it("with no booking speed condition, the ? names the pickup wait itself", () => {
    render(<Builder onRow={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "How the wait works" }));
    expect(screen.getByRole("tooltip").textContent).toContain("leaves that night alone for 1 week.");
    fireEvent.change(screen.getByLabelText("Then waits (advanced)"), { target: { value: "2" } });
    expect(screen.getByRole("tooltip").textContent).toContain("leaves that night alone for 2 days.");
    expect(screen.getByRole("tooltip").textContent).not.toContain("Its booking speed condition");
  });

  it("on a rule for low pickup, says the choices under its window are held to it, and the ? says why", () => {
    // pickupJudgesShortStretch: after a change a low pickup count is only
    // judged on a whole window, so a shorter wait changes nothing.
    render(<Builder onRow={() => {}} operator="lt" />);
    expect(optionTexts()).toEqual([
      "Same as the lookback window",
      "1 day (low pickup holds it to 1 week)",
      "2 days (low pickup holds it to 1 week)",
      "3 days (low pickup holds it to 1 week)",
      "1 week",
      "2 weeks",
    ]);
    fireEvent.change(screen.getByLabelText("Then waits (advanced)"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "How the wait works" }));
    const panel = screen.getByRole("tooltip").textContent ?? "";
    expect(panel).toContain("leaves that night alone for 1 week.");
    expect(panel).toContain("It looks for low pickup");
    expect(panel).not.toContain("When the wait is over it counts pickup");
  });
});
