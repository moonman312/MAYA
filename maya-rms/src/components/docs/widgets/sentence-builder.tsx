"use client";

import { useState } from "react";
import { Output, SelectField } from "./controls";

// The change log's sentence shapes at The Harbour Inn, as the change log
// page lists them: the rule's own line, then the reason.
const SHAPES = {
  "occupancy-greater": {
    label: "Sellable occupancy, Greater than 80",
    rule: '"Busy nights" raised this night 10%, from $200.00 to $220.00.',
    why: "It was 85% full, past the 80% mark you set.",
  },
  "occupancy-less": {
    label: "Sellable occupancy, Less than 50",
    rule: '"Quiet nights" lowered this night 10%, from $200.00 to $180.00.',
    why: "It was 40% full, under the 50% mark you set.",
  },
  "window-less": {
    label: "Booking window, Less than 3",
    rule: '"Close in" lowered this night 10%, from $200.00 to $180.00.',
    why: "It had 2 days to go, past the 3-day mark you set.",
  },
  "window-greater": {
    label: "Booking window, Greater than 21",
    rule: '"Book early" raised this night 5%, from $200.00 to $210.00.',
    why: "It had 30 days to go, beyond the 21-day mark you set.",
  },
  "both-last-minute": {
    label: '"Last minute": booking window Less than 3 and occupancy Less than 50',
    rule: '"Last minute" lowered this night 15%, from $200.00 to $170.00.',
    why: "It was 40% full with 2 days to go, under the 50% mark and past the 3-day mark you set.",
  },
  "pickup-greater": {
    label: "Pickup count, Greater than 4, last 3 days",
    rule: '"Quick pickup" raised this night 10%, from $200.00 to $220.00.',
    why: "9 bookings arrived in the last 3 days, past the 4-booking mark you set.",
  },
  "speed-faster": {
    label: 'Booking speed, "Warm-date bump" (Faster Than Normal, past month)',
    rule: '"Warm-date bump" raised this night 10%, from $200.00 to $220.00.',
    why: "Bookings came in faster than normal this past month: 9, against the 5 a night like this usually has by now.",
  },
  "speed-surging": {
    label: 'Booking speed, "Sudden-spike catcher" (Surging, past day)',
    rule: '"Sudden-spike catcher" raised this night 25%, from $200.00 to $250.00.',
    why: "Bookings surged this past day: 4, where a night like this usually has almost none by now.",
  },
  "speed-after-raise": {
    label: 'Booking speed, "Hot-week surge" again after its wait',
    rule: 'Then "Hot-week surge" raised it another 25%, from $250.00 to $312.50.',
    why: "Bookings came in much faster than normal in the 3 days since this night was last raised: 6, against the 2 a night like this usually gets in those days.",
  },
  "speed-stalled": {
    label: 'Booking speed, "Slow-date rescue" (at most Much Slower Than Normal, past month)',
    rule: '"Slow-date rescue" lowered this night 15%, from $200.00 to $170.00.',
    why: "Bookings came in much slower than normal this past month: none, against the 5 a night like this usually has by now.",
  },
} as const;

type ShapeKey = keyof typeof SHAPES;

export function SentenceBuilderLive() {
  const [kind, setKind] = useState<ShapeKey>("occupancy-greater");
  const shape = SHAPES[kind];
  return (
    <div className="space-y-5">
      <SelectField
        label="The rule that acted"
        value={kind}
        onChange={setKind}
        options={(Object.keys(SHAPES) as ShapeKey[]).map((k) => ({ value: k, label: SHAPES[k].label }))}
      />
      <Output changeKey={kind}>
        <p className="text-xs text-muted-foreground">Deluxe, Friday, November 13, 2026</p>
        <p className="mt-2 text-[0.975rem] text-foreground">
          {shape.rule} {shape.why}
        </p>
      </Output>
    </div>
  );
}
