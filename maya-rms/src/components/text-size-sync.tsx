"use client";

import { useEffect, useSyncExternalStore } from "react";
import { applyTextSize, currentTextSize, textSizeFixScript, type TextSize } from "@/lib/text-size";

const noSubscribe = () => () => {};

/**
 * On the dashboard, ahead of everything else it draws, when this browser's
 * cookie holds another size than the person's profile: a script that sets
 * the saved size while the page is still loading, so the dashboard is never
 * drawn at the old size first. It is only in the page the server sends (a
 * script only runs there); a page opened inside the app renders nothing
 * here and TextSizeSync puts it right.
 */
export function TextSizeFix({ size }: { size: TextSize }) {
  // True while the server draws the page and while the browser takes it
  // over, false for a page drawn in the browser.
  const fromServer = useSyncExternalStore(
    noSubscribe,
    () => false,
    () => true,
  );
  if (!fromServer) return null;
  return <script dangerouslySetInnerHTML={{ __html: textSizeFixScript(size) }} />;
}

/**
 * The text size saved on the person's profile, brought to this browser when
 * it still shows something else. The page the server sends is already right
 * (TextSizeFix); this covers the dashboard opened from another page inside
 * the app, and a browser that blocked the script.
 */
export function TextSizeSync({ saved }: { saved: TextSize | null }) {
  useEffect(() => {
    if (saved && saved !== currentTextSize()) applyTextSize(saved);
  }, [saved]);
  return null;
}
