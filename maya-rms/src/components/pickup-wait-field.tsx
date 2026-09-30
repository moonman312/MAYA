"use client";

/**
 * "Then waits (advanced)" beside a pickup count condition's lookback window
 * in the rule builder: how long the rule leaves a night alone after it
 * adjusts it. It starts on "Same as the lookback window", saved as null,
 * which is what every pickup count rule did before the choice existed. The
 * other choices are the ones a booking speed rule gets.
 *
 * A rule that also has a booking speed condition waits the longer of the two
 * (ruleWaitDays in engine/pickup.ts), and a rule that looks for low pickup
 * never adjusts a night again before its whole window has passed
 * (pickupJudgesShortStretch), so a choice either would hold longer says so,
 * and the "?" names the wait the rule really keeps.
 */

import { RoomCountHelp } from "@/components/room-type-settings";
import { pickupWaitHelp } from "@/lib/booking-speed-help";
import {
  BOOKING_SPEED_WAIT_OPTIONS,
  PICKUP_WAIT_SAME_AS_WINDOW_LABEL,
  bookingSpeedOwnWait,
  bookingSpeedSetsWait,
  eventRuleWaitDays,
  waitDaysLabel,
  type BookingSpeedWaitDays,
} from "@/lib/rule-form";

const SAME = "same";

export function PickupWaitField({
  id,
  value,
  windowDays,
  lowPickup = false,
  bookingSpeedCooldownDays,
  onChange,
}: {
  id: string;
  /** The chosen wait, or null for the lookback window. */
  value: BookingSpeedWaitDays | null;
  /** The condition's lookback window. */
  windowDays: number;
  /** The condition looks for low pickup (pickupCountsLow). */
  lowPickup?: boolean;
  /** The rule's booking speed wait when it has that condition too (null reads as a week), else undefined. */
  bookingSpeedCooldownDays?: number | null;
  onChange: (value: BookingSpeedWaitDays | null) => void;
}) {
  const waitInput = {
    hasBookingSpeed: bookingSpeedCooldownDays !== undefined,
    cooldownDays: bookingSpeedCooldownDays ?? null,
    hasPickup: true,
    pickupWindowDays: windowDays,
    pickupCooldownDays: value,
    pickupLow: lowPickup,
  };
  const waitLabel = waitDaysLabel(eventRuleWaitDays(waitInput));
  const speedWait = bookingSpeedOwnWait(waitInput);
  const lowWait = lowPickup ? windowDays : 0;
  // What holds a choice longer than itself, the longer of the two when both do.
  const heldBySpeed = (days: number) =>
    speedWait > days && speedWait >= lowWait
      ? ` (booking speed holds it to ${waitDaysLabel(speedWait)})`
      : lowWait > days
        ? ` (low pickup holds it to ${waitDaysLabel(lowWait)})`
        : "";

  return (
    <div>
      <div className="mb-0.5 flex items-center gap-1.5">
        <label htmlFor={id} className="block text-[0.6875rem] text-slate-500">
          Then waits (advanced)
        </label>
        <RoomCountHelp {...pickupWaitHelp(waitLabel, bookingSpeedSetsWait(waitInput) ? waitLabel : null, lowPickup)} />
      </div>
      <select
        id={id}
        className="w-full rounded border border-slate-700 bg-slate-950 p-2 text-sm"
        value={value == null ? SAME : String(value)}
        onChange={(e) =>
          onChange(e.target.value === SAME ? null : (Number(e.target.value) as BookingSpeedWaitDays))
        }
      >
        <option value={SAME}>
          {PICKUP_WAIT_SAME_AS_WINDOW_LABEL}
          {heldBySpeed(windowDays)}
        </option>
        {BOOKING_SPEED_WAIT_OPTIONS.map((o) => (
          <option key={o.days} value={o.days}>
            {o.label}
            {heldBySpeed(o.days)}
          </option>
        ))}
      </select>
    </div>
  );
}
