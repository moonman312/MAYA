"use client";

/**
 * Which mode the property on screen is in, and whether the person looking may
 * take it live, from GET /api/property/mode (src/lib/simulation-strip.ts).
 * Shared by the simulation strip and the review card's go-live button, so
 * the two ways in offer Go live on the same terms.
 *
 * Null until it is known, and again while it is read for a new `hotelId`, so
 * nothing shows the last property's mode under the next one's name. Once a
 * property goes live from this tab (requestGoLive's WENT_LIVE_EVENT), every
 * reader of it shows Live at once.
 */

import { useEffect, useState } from "react";
import { WENT_LIVE_EVENT } from "@/components/go-live-dialog";
import type { PropertyMode } from "@/lib/simulation-strip";

export type PropertyModeView = PropertyMode & {
  /** The property the answer is about: the active one when it was read. */
  hotelId: string | null;
  /** Its name, for the confirm's title. */
  propertyName: string | null;
};

export function usePropertyMode(hotelId?: string | null): PropertyModeView | null {
  // Keyed by the property it was read for: a new one reads as unknown until its own answer.
  const [read, setRead] = useState<{ for: string | null; mode: PropertyModeView | null } | null>(null);
  const key = hotelId ?? null;

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/property/mode", { cache: "no-store" });
        const body = res.ok ? ((await res.json()) as Partial<PropertyModeView>) : null;
        const mode =
          body && (body.mode === "simulation" || body.mode === "live")
            ? ({ ...body, hotelId: body.hotelId ?? null, propertyName: body.propertyName ?? null } as PropertyModeView)
            : null;
        if (alive) setRead({ for: key, mode });
      } catch {
        // Unsure means nothing to show: the mode is never guessed.
        if (alive) setRead({ for: key, mode: null });
      }
    })();
    return () => {
      alive = false;
    };
  }, [key]);

  useEffect(() => {
    const onLive = (e: Event) => {
      const wentLive = (e as CustomEvent<{ hotelId: string | null }>).detail?.hotelId ?? null;
      setRead((r) => {
        if (!r?.mode) return r;
        if (wentLive != null && r.mode.hotelId != null && wentLive !== r.mode.hotelId) return r;
        return { ...r, mode: { ...r.mode, mode: "live", canGoLive: false } };
      });
    };
    window.addEventListener(WENT_LIVE_EVENT, onLive);
    return () => window.removeEventListener(WENT_LIVE_EVENT, onLive);
  }, []);

  return read && read.for === key ? read.mode : null;
}
