"use client";

/**
 * Live calendar refresh hook.
 *
 * Subscribes to Supabase Realtime postgres_changes on the tables the engine
 * writes (published_price, reservations) plus manual_price and
 * room_type_out_of_service, which a person writes, for the active hotel, and invokes
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

// manual_price is here so a price typed in one tab shows up in another
// without waiting for the engine to republish the cell; room_type_out_of_service
// because a block changes the day card's sellable denominator on its own.
const LIVE_TABLES = ["published_price", "reservations", "manual_price", "room_type_out_of_service"] as const;

const REFRESH_DEBOUNCE_MS = 2000;
/** However busy the stream, a price change reaches the calendar this soon. */
const REFRESH_MAX_WAIT_MS = 10_000;
/**
 * A burst of reservation changes alone waits longer. An import or a daily
 * sweep on a large property streams row changes for hours, and every refresh
 * clears the month cache and reloads it, so ten seconds meant a full calendar
 * read every ten seconds per open tab. Prices still land within
 * REFRESH_MAX_WAIT_MS: any other table in the burst brings the refresh forward.
 */
const RESERVATIONS_MAX_WAIT_MS = 60_000;

/* ── Debounce helper (exported for tests) ─────────────────────── */

export interface Debounced {
  /**
   * Schedule `fn`; resets the timer if already pending. `maxWaitMs` overrides
   * the default ceiling for this call; the burst keeps the shortest one seen.
   */
  call: (maxWaitMs?: number) => void;
  /** Drop any pending invocation. */
  cancel: () => void;
}

export function createDebounced(fn: () => void, delayMs: number, maxWaitMs?: number): Debounced {
  let timer: ReturnType<typeof setTimeout> | null = null;
  // When the current burst began. A steady stream of changes (an import
  // writing thousands of reservation rows) never pauses for `delayMs`, so
  // without a ceiling the refresh would never run at all.
  let burstStartedAt: number | null = null;
  // The latest the burst may run to, from the shortest ceiling any call gave.
  let burstDeadline: number | null = null;
  return {
    call: (callMaxWaitMs?: number) => {
      if (timer !== null) clearTimeout(timer);
      const now = Date.now();
      if (burstStartedAt === null) burstStartedAt = now;
      const ceiling = callMaxWaitMs ?? maxWaitMs;
      if (ceiling !== undefined) {
        const deadline = burstStartedAt + ceiling;
        burstDeadline = burstDeadline === null ? deadline : Math.min(burstDeadline, deadline);
      }
      const wait = burstDeadline === null ? delayMs : Math.max(0, Math.min(delayMs, burstDeadline - now));
      timer = setTimeout(() => {
        timer = null;
        burstStartedAt = null;
        burstDeadline = null;
        fn();
      }, wait);
    },
    cancel: () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      burstStartedAt = null;
      burstDeadline = null;
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

    const debounced = createDebounced(() => onChangeRef.current(), REFRESH_DEBOUNCE_MS, REFRESH_MAX_WAIT_MS);

    let supabase: SupabaseClient | null = null;
    let channel: RealtimeChannel | null = null;
    try {
      supabase = createClient();
      channel = supabase.channel(`calendar-live-${hotelId}`);
      for (const table of LIVE_TABLES) {
        channel.on(
          "postgres_changes",
          { event: "*", schema: "public", table, filter: `hotel_id=eq.${hotelId}` },
          () => debounced.call(table === "reservations" ? RESERVATIONS_MAX_WAIT_MS : undefined),
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
