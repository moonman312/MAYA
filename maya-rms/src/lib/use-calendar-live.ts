"use client";

/**
 * Live calendar refresh hook.
 *
 * Subscribes to Supabase Realtime postgres_changes on the tables the engine
 * writes (published_price, reservations) for the active hotel, and invokes
 * `onChange` after the burst settles.  An engine run touches hundreds of rows,
 * so the callback is debounced: one refresh per burst, not one per row.
 *
 * Requires the tables to be in the `supabase_realtime` publication — see
 * 99_supabase_migration_realtime_v1.sql.  If Realtime is unavailable (env not
 * configured, publication missing) the hook is a silent no-op.
 */

import { createClient } from "@/utils/supabase/client";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useRef } from "react";

const LIVE_TABLES = ["published_price", "reservations"] as const;

const REFRESH_DEBOUNCE_MS = 2000;

/* ── Debounce helper (exported for tests) ─────────────────────── */

export interface Debounced {
  /** Schedule `fn`; resets the timer if already pending. */
  call: () => void;
  /** Drop any pending invocation. */
  cancel: () => void;
}

export function createDebounced(fn: () => void, delayMs: number): Debounced {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    call: () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn();
      }, delayMs);
    },
    cancel: () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

/* ── Hook ─────────────────────────────────────────────────────── */

export function useCalendarLive(hotelId: string | null, onChange: () => void): void {
  // Keep the latest callback in a ref so the subscription effect only
  // re-runs when the hotel changes, not on every render.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!hotelId || !isSupabaseConfigured()) return;

    const debounced = createDebounced(() => onChangeRef.current(), REFRESH_DEBOUNCE_MS);

    let supabase: SupabaseClient | null = null;
    let channel: RealtimeChannel | null = null;
    try {
      supabase = createClient();
      channel = supabase.channel(`calendar-live-${hotelId}`);
      for (const table of LIVE_TABLES) {
        channel.on(
          "postgres_changes",
          { event: "*", schema: "public", table, filter: `hotel_id=eq.${hotelId}` },
          () => debounced.call(),
        );
      }
      channel.subscribe();
    } catch {
      // Live updates are an enhancement — polling/manual refresh still works.
      channel = null;
    }

    return () => {
      debounced.cancel();
      if (supabase && channel) {
        try {
          supabase.removeChannel(channel);
        } catch {
          // Ignore teardown failures; the socket is going away anyway.
        }
      }
    };
  }, [hotelId]);
}
