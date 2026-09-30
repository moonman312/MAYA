"use client";

import { isAcceptanceExemptPath } from "@/lib/legal/versions";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Fired by the God Mode button once a window is open, so this banner shows
 * without a page load.
 */
export const GOD_MODE_CHANGED_EVENT = "maya:god-mode-changed";

type Status = {
  active: boolean;
  expiresAt: string | null;
  hotel: { id: string; name: string } | null;
};

/** "12 min left", "1 min left", "less than a minute left". */
export function timeLeftWords(msLeft: number): string {
  if (msLeft < 60_000) return "less than a minute left";
  const minutes = Math.ceil(msLeft / 60_000);
  return `${minutes} min left`;
}

/**
 * The red banner across the top of the signed-in pages while God Mode is on
 * for the signed-in platform admin: that it covers every property, how long is
 * left, and the way out. Only ever rendered for a platform admin: the server
 * decides that in GodModeBannerSlot, so nobody else loads or asks anything.
 * For the admin it asks /api/admin/god-mode when it first shows, when the God
 * Mode button says the window changed, when the tab comes back into view, and
 * on a page change once the last answer is a minute old (not on every click:
 * each ask is a second server call beside the page's own). It shows nothing
 * while no window is open.
 *
 * The time left counts down from the window's expires_at, which is the
 * database's own; when it reaches zero the banner says so and reloads the
 * page, so nothing on screen still believes it can change the property.
 */
const reloadPage = () => window.location.reload();

/** A page change asks again only when the last answer is older than this. */
export const GOD_MODE_RECHECK_MS = 60_000;

export function GodModeBanner({ reload = reloadPage }: { reload?: () => void } = {}) {
  const pathname = usePathname();
  const router = useRouter();
  const exempt = isAcceptanceExemptPath(pathname);
  const [status, setStatus] = useState<Status | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [ended, setEnded] = useState(false);
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const askedAt = useRef(0);

  const load = useCallback(async () => {
    askedAt.current = Date.now();
    try {
      const res = await fetch("/api/admin/god-mode", { cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as { admin?: boolean; active?: boolean; expiresAt?: string | null; hotel?: Status["hotel"] };
      if (body.admin === true && body.active === true && body.expiresAt) {
        setStatus({ active: true, expiresAt: body.expiresAt, hotel: body.hotel ?? null });
        setEnded(false);
        setNow(Date.now());
      } else {
        setStatus(null);
      }
    } catch {
      // Unsure means nothing to show; the database still refuses every write.
    }
  }, []);

  useEffect(() => {
    if (exempt) return;
    if (askedAt.current && Date.now() - askedAt.current < GOD_MODE_RECHECK_MS) return;
    void load();
  }, [exempt, pathname, load]);

  // A window opened or closed in another tab shows here when this tab is looked at again.
  useEffect(() => {
    if (exempt) return;
    const onBack = () => {
      // Coming back fires both events; one ask covers them.
      if (document.visibilityState === "visible" && Date.now() - askedAt.current > 2_000) void load();
    };
    window.addEventListener("focus", onBack);
    document.addEventListener("visibilitychange", onBack);
    return () => {
      window.removeEventListener("focus", onBack);
      document.removeEventListener("visibilitychange", onBack);
    };
  }, [exempt, load]);

  useEffect(() => {
    const onChanged = () => void load();
    window.addEventListener(GOD_MODE_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(GOD_MODE_CHANGED_EVENT, onChanged);
  }, [load]);

  const expiresAt = status?.expiresAt ? Date.parse(status.expiresAt) : null;
  const msLeft = expiresAt != null ? expiresAt - now : null;

  useEffect(() => {
    if (!status?.active || ended) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [status, ended]);

  useEffect(() => {
    if (!status?.active || ended || msLeft == null || msLeft > 0) return;
    setEnded(true);
  }, [status, ended, msLeft]);

  // A moment to read "ended", then the page reloads with nothing on it still
  // believing it can change the property.
  useEffect(() => {
    if (!ended) return;
    const timer = setTimeout(reload, 1500);
    return () => clearTimeout(timer);
  }, [ended, reload]);

  // The banner floats over the top of the page, so the page makes room for it:
  // the body is padded by the banner's own height (two lines on a phone) while
  // it shows, and the menus underneath stay where they can be clicked.
  const bannerRef = useRef<HTMLDivElement | null>(null);
  const showing = !exempt && Boolean(status?.active);
  useEffect(() => {
    if (!showing) return;
    const el = bannerRef.current;
    if (!el) return;
    const body = document.body;
    const before = body.style.paddingTop;
    const fit = () => {
      body.style.paddingTop = `${el.offsetHeight}px`;
    };
    fit();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    observer?.observe(el);
    return () => {
      observer?.disconnect();
      body.style.paddingTop = before;
    };
  }, [showing]);

  async function endNow() {
    setEnding(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/god-mode", { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "Could not end God Mode. Try again.");
        return;
      }
      setStatus(null);
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setEnding(false);
    }
  }

  if (exempt || !status?.active) return null;

  // A window covers every property, whichever one is on screen; the one on
  // screen is named only so the admin knows where they are.
  const onAdmin = pathname === "/admin" || pathname?.startsWith("/admin/");
  const where = !onAdmin && status.hotel ? `all properties, ${status.hotel.name} included` : "all properties";

  return (
    <div
      ref={bannerRef}
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 top-0 z-[900] flex flex-wrap items-center justify-center gap-x-4 gap-y-1 bg-red-600 px-4 py-2 text-sm font-medium text-white shadow-lg"
    >
      {ended ? (
        <span>God Mode ended. Reloading the page.</span>
      ) : (
        <>
          <span>
            God Mode is on for {where}: {timeLeftWords(msLeft ?? 0)}
          </span>
          <button
            type="button"
            onClick={() => void endNow()}
            disabled={ending}
            className="cursor-pointer rounded border border-white/70 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide hover:bg-white/10 disabled:opacity-60"
          >
            End God Mode
          </button>
          {error ? <span className="text-xs text-red-100">{error}</span> : null}
        </>
      )}
    </div>
  );
}
