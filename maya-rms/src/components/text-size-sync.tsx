"use client";

import { useEffect } from "react";
import { applyTextSize, currentTextSize, type TextSize } from "@/lib/text-size";

/**
 * The text size saved on the person's profile, brought to this browser when
 * it shows something else: a size chosen on another device, or someone
 * else's left in the cookie. Only a browser that was out of step ever sees
 * the page change size, and only on the first page after it.
 */
export function TextSizeSync({ saved }: { saved: TextSize | null }) {
  useEffect(() => {
    if (saved && saved !== currentTextSize()) applyTextSize(saved);
  }, [saved]);
  return null;
}
