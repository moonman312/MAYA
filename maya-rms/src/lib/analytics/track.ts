"use client";

/**
 * Sending a product moment from the browser. Fire and forget: nothing waits
 * on it, nothing retries it, and a failure is invisible, because analytics
 * must never be the reason a button feels slow or a page shows an error.
 *
 * keepalive is what lets the two moments that happen on the way out of the
 * page (checkout started, portal opened) survive the navigation to Stripe.
 */

import { useEffect } from "react";
import type { UiEventName, UiEventProps } from "./events";

export function track<E extends UiEventName>(event: E, properties?: UiEventProps<E>, hotelId?: string | null): void {
  try {
    void fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, properties: properties ?? {}, hotelId: hotelId ?? null }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // No fetch, or a body the browser refused: not worth a sound.
  }
}

const sentThisLoad = new Set<string>();

/** At most once per page load per event and property: re-renders and Strict Mode's double effects included. */
export function trackOnce<E extends UiEventName>(event: E, properties?: UiEventProps<E>, hotelId?: string | null): void {
  const key = `${event}:${hotelId ?? ""}`;
  if (sentThisLoad.has(key)) return;
  sentThisLoad.add(key);
  track(event, properties, hotelId);
}

/** trackOnce when the component mounts, or when `event` stops being false. */
export function useTrackOnce<E extends UiEventName>(
  event: E | false,
  properties?: UiEventProps<E>,
  hotelId?: string | null,
): void {
  // Properties are read at the moment it fires; changing them later is not a
  // second view.
  const snapshot = JSON.stringify(properties ?? {});
  useEffect(() => {
    if (event) trackOnce(event, JSON.parse(snapshot) as UiEventProps<E>, hotelId);
  }, [event, hotelId, snapshot]);
}
