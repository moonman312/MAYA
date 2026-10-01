"use client";

import { useCallback, useRef, useState } from "react";
import { fetchChangelogPage } from "@/lib/changelog-paging";

/**
 * The change log's items, page by page (src/lib/changelog-paging.ts).
 * `reload` reads the newest page again and drops any older ones shown;
 * `loadOlder` adds the next, older page below. A reload while an older page
 * is on its way wins: that page is dropped, since it belonged to the list
 * before.
 */
export function useChangelogPages<T>() {
  const [items, setItems] = useState<T[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [older, setOlder] = useState<string | null>(null);
  const [olderBusy, setOlderBusy] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const [pagedBack, setPagedBack] = useState(false);
  const generation = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++generation.current;
    setError(null);
    setOlderError(null);
    setOlderBusy(false);
    try {
      const page = await fetchChangelogPage<T>();
      if (mine !== generation.current) return;
      setItems(page.items);
      setOlder(page.older);
      setPagedBack(false);
    } catch {
      // Keep whatever loaded before: it was real. Never fill the gap.
      if (mine === generation.current) setError("Couldn't load your price history.");
    }
  }, []);

  const loadOlder = useCallback(async () => {
    if (!older) return;
    const mine = generation.current;
    setOlderBusy(true);
    setOlderError(null);
    try {
      const page = await fetchChangelogPage<T>(older);
      if (mine !== generation.current) return;
      setItems((list) => [...list, ...page.items]);
      setOlder(page.older);
      setPagedBack(true);
    } catch {
      if (mine === generation.current) setOlderError("Couldn't load older history.");
    } finally {
      if (mine === generation.current) setOlderBusy(false);
    }
  }, [older]);

  return { items, error, reload, older, loadOlder, olderBusy, olderError, pagedBack };
}
