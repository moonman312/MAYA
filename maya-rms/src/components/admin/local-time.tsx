"use client";

import { useSyncExternalStore } from "react";

/** The browser's own day, read again whenever the tab is looked at again. */
function subscribe(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  window.addEventListener("focus", onChange);
  return () => {
    document.removeEventListener("visibilitychange", onChange);
    window.removeEventListener("focus", onChange);
  };
}

const localDay = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
const browserToday = () => localDay(new Date());

/**
 * HH:MM in the reader's own time zone, with the date in front ("Sep 29,
 * 23:58") when it was not today, so a page left open overnight never reads as
 * fresh. The server doesn't know the time zone, so the first paint says the
 * UTC time and names it (dated against the server's day, serverToday), and
 * the browser swaps in local time straight after, with no mismatch between
 * the two renders. Coming back to the tab checks the day again.
 */
export function LocalTime({ iso, serverToday }: { iso: string; serverToday: string }) {
  const today = useSyncExternalStore(subscribe, browserToday, () => null);
  const at = new Date(iso);
  let text: string;
  if (today !== null) {
    const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
    text = localDay(at) === today ? time : `${at.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
  } else {
    const time = `${at.toISOString().slice(11, 16)} UTC`;
    text =
      at.toISOString().slice(0, 10) === serverToday
        ? time
        : `${at.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" })}, ${time}`;
  }
  return (
    <time dateTime={at.toISOString()} title={at.toISOString()}>
      {text}
    </time>
  );
}
