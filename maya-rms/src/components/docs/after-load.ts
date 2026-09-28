interface Connection {
  saveData?: boolean;
  effectiveType?: string;
}

/** Data saver on, or a 2G connection: leave downloads until the reader asks for them. */
export function wantsLessData(nav: Navigator | undefined = typeof navigator === "undefined" ? undefined : navigator): boolean {
  const c = (nav as (Navigator & { connection?: Connection }) | undefined)?.connection;
  if (!c) return false;
  return c.saveData === true || c.effectiveType === "slow-2g" || c.effectiveType === "2g";
}

const IDLE_TIMEOUT_MS = 5000;
const FALLBACK_DELAY_MS = 1500;

/**
 * Runs `start` once the page has finished loading (its images and fonts are
 * in) and the browser is idle, so a background download never competes with
 * what the reader is looking at. Returns a cancel for anything still waiting.
 */
export function afterLoadAndIdle(start: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  let cancelled = false;
  let idleId: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const run = () => {
    if (!cancelled) start();
  };
  const whenIdle = () => {
    if (cancelled) return;
    if (typeof window.requestIdleCallback === "function") idleId = window.requestIdleCallback(run, { timeout: IDLE_TIMEOUT_MS });
    else timer = setTimeout(run, FALLBACK_DELAY_MS);
  };

  if (document.readyState === "complete") whenIdle();
  else window.addEventListener("load", whenIdle, { once: true });

  return () => {
    cancelled = true;
    window.removeEventListener("load", whenIdle);
    if (idleId !== null && typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(idleId);
    if (timer !== null) clearTimeout(timer);
  };
}
