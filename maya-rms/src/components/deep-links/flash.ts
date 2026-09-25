"use client";

// Scrolls to the place a link opened and rings it for a moment. Targets are
// [data-deeplink] ids from the registry (plus a checked uuid for a row),
// never anything from the address as a selector. Waits for content that
// loads after the page, and gives up quietly. Focus moves to the highlighted
// box itself, never into a field, so Enter can never save anything.

export function flashWhenReady(id: string, options: { timeoutMs?: number } = {}): () => void {
  if (typeof window === "undefined" || !id) return () => {};
  const timeoutMs = options.timeoutMs ?? 6000;
  const selector = `[data-deeplink="${CSS.escape(id)}"]`;
  let done = false;
  let observer: MutationObserver | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let clear: ReturnType<typeof setTimeout> | null = null;

  const stop = () => {
    done = true;
    observer?.disconnect();
    if (timer) clearTimeout(timer);
  };

  const hit = (el: HTMLElement) => {
    stop();
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    el.scrollIntoView?.({ block: "center", behavior: reduce ? "auto" : "smooth" });
    if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
    el.focus?.({ preventScroll: true });
    el.setAttribute("data-dl-flash", "");
    clear = setTimeout(() => el.removeAttribute("data-dl-flash"), reduce ? 2000 : 1800);
  };

  const look = () => {
    if (done) return;
    const el = document.querySelector<HTMLElement>(selector);
    if (el) hit(el);
  };

  look();
  if (!done) {
    observer = new MutationObserver(look);
    observer.observe(document.body, { childList: true, subtree: true });
    timer = setTimeout(stop, timeoutMs);
  }
  return () => {
    stop();
    if (clear) clearTimeout(clear);
  };
}
