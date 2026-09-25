import { fallbackFor } from "@/lib/docs/widget-fallbacks.mjs";
import { WidgetFrame } from "./frame";
import { OccupancySliderLive, type OccupancySliderProps } from "./occupancy-slider";
import { BookingSpeedPlaygroundLive } from "./booking-speed-playground";
import { StackingCalculatorLive } from "./stacking-calculator";
import { WaitTimelineLive } from "./wait-timeline";
import { PriceCalculatorLive } from "./price-calculator";
import { FloorLadderLive } from "./floor-ladder";
import { SentenceBuilderLive } from "./sentence-builder";
import { DateStripLive } from "./date-strip";
import { AppTourLive } from "./app-tour";
export { MessageFinder } from "./message-finder";

// Each "Try it" widget as the MDX pages use it: the live piece inside the
// shared frame, with the fallback sentence the docs index also carries.

const fb = (name: string, props: Record<string, unknown> = {}) => fallbackFor(name, props) ?? "";

export function OccupancySlider(props: OccupancySliderProps) {
  return (
    <WidgetFrame what="Change the rooms, the bookings and the line, and see whether the rule fires." fallback={fb("OccupancySlider", { ...props })}>
      <OccupancySliderLive {...props} />
    </WidgetFrame>
  );
}

export function BookingSpeedPlayground() {
  return (
    <WidgetFrame what="Set what is usual and what came in, and watch each check read the night." fallback={fb("BookingSpeedPlayground")}>
      <BookingSpeedPlaygroundLive />
    </WidgetFrame>
  );
}

export function StackingCalculator() {
  return (
    <WidgetFrame what="Stack two rules on a price and see where the floor and ceiling hold it." fallback={fb("StackingCalculator")}>
      <StackingCalculatorLive />
    </WidgetFrame>
  );
}

export function WaitTimeline() {
  return (
    <WidgetFrame what="Pick a wait and see which days a rule counts when it reads the night again." fallback={fb("WaitTimeline")}>
      <WaitTimelineLive />
    </WidgetFrame>
  );
}

export function PriceCalculator() {
  return (
    <WidgetFrame what="Type your room count and see the bill." fallback={fb("PriceCalculator")}>
      <PriceCalculatorLive />
    </WidgetFrame>
  );
}

export function FloorLadder() {
  return (
    <WidgetFrame what="Type a turnover cost and walk the floor question's offers." fallback={fb("FloorLadder")}>
      <FloorLadderLive />
    </WidgetFrame>
  );
}

export function SentenceBuilder() {
  return (
    <WidgetFrame what="Pick the kind of rule and read the sentence the change log writes." fallback={fb("SentenceBuilder")}>
      <SentenceBuilderLive />
    </WidgetFrame>
  );
}

export function DateStrip() {
  return (
    <WidgetFrame what="Set a booking window and see which nights it covers from tonight." fallback={fb("DateStrip")}>
      <DateStripLive />
    </WidgetFrame>
  );
}

export function AppTour() {
  return (
    <WidgetFrame what="Point at a number to see what each part of the app does." fallback={fb("AppTour")}>
      <AppTourLive />
    </WidgetFrame>
  );
}
