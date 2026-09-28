import manifest from "@/lib/docs/generated/ask-manifest.json";
import { expandIndex, type AskIndex, type AskWire } from "@/lib/docs/ask/match";
import { createHelper, type Helper } from "@/lib/docs/ask/respond";
import { afterLoadAndIdle, wantsLessData } from "../after-load";

export interface LoadedHelper {
  index: AskIndex;
  helper: Helper;
}

// One download per visit: the background fetch and the panel share this
// promise. A failure clears it, so the next call (opening the panel) retries.
let loading: Promise<LoadedHelper> | null = null;

export function loadHelper(): Promise<LoadedHelper> {
  if (!loading) {
    loading = fetch(manifest.file)
      .then((r) => {
        if (!r.ok) throw new Error(`docs index ${r.status}`);
        return r.json() as Promise<AskWire>;
      })
      .then((wire) => {
        const index: AskIndex = expandIndex(wire);
        return { index, helper: createHelper(index) };
      })
      .catch((err) => {
        loading = null;
        throw err;
      });
  }
  return loading;
}

// Set once the background download has started this visit. Module state
// outlives client-side navigation between docs pages, so it never runs twice.
let prefetched = false;

/**
 * Starts the helper's download in the background once the page has finished
 * loading (its images and fonts are in) and the browser is idle. Returns a
 * cancel for anything still waiting. Errors are swallowed: the panel shows
 * them, and retries, only when the reader opens it.
 */
export function prefetchHelper(): () => void {
  if (prefetched || wantsLessData()) return () => {};
  return afterLoadAndIdle(() => {
    if (prefetched) return;
    prefetched = true;
    loadHelper().catch(() => {});
  });
}

/** Tests only: forget this visit's download. */
export function resetHelperLoad() {
  loading = null;
  prefetched = false;
}
