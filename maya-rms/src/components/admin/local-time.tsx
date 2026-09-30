"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * HH:MM in the reader's own time zone. The server doesn't know it, so the
 * first paint says the UTC time and names it, and the browser swaps in local
 * time straight after, with no mismatch between the two renders.
 */
export function LocalTime({ iso }: { iso: string }) {
  const inBrowser = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const at = new Date(iso);
  const text = inBrowser
    ? at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
    : `${at.toISOString().slice(11, 16)} UTC`;
  return (
    <time dateTime={at.toISOString()} title={at.toISOString()}>
      {text}
    </time>
  );
}
