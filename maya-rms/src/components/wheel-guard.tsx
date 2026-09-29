"use client";

import { useEffect } from "react";

/**
 * Scrolling never changes a number. A focused number box steps its value when
 * the mouse wheel or trackpad scrolls over it, so an owner who types a price
 * and scrolls on can end up with a different number without noticing. Leaving
 * the box on the first wheel tick keeps what they typed and lets the page
 * scroll as usual. Arrow keys still step the value.
 */
export function blurNumberInputOnWheel(event: WheelEvent) {
  const active = document.activeElement;
  if (active instanceof HTMLInputElement && active.type === "number" && event.target === active) {
    active.blur();
  }
}

export function WheelGuard() {
  useEffect(() => {
    document.addEventListener("wheel", blurNumberInputOnWheel, { capture: true, passive: true });
    return () => document.removeEventListener("wheel", blurNumberInputOnWheel, { capture: true });
  }, []);
  return null;
}
