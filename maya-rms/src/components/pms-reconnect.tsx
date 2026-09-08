"use client";

/**
 * Getting a dead PMS connection working again, without asking anyone for help.
 *
 * A revoked token, a password change, a staff member removing the integration —
 * all of them leave a hotel whose prices silently stop updating, and until this
 * existed the only route back was emailing us. The API for it was already there
 * and guarded (can_manage_hotel); nothing had ever put it on screen.
 *
 * One click for an OAuth property: straight out to the vendor, straight back
 * connected, no fields to fill in. A key-based PMS genuinely cannot work that
 * way — the credentials come from their own PMS dashboard — so it says so
 * plainly rather than offering a button that leads nowhere.
 */

const BROKEN = new Set(["error", "degraded", "disconnected"]);

export function PmsReconnect({
  hotelId,
  pmsType,
  status,
  authKind,
  displayName,
  canManage,
  placement = "panel",
}: {
  hotelId: string | null;
  pmsType: string;
  status: string;
  authKind: string;
  displayName: string;
  /** Whether this viewer holds the rank the reconnect route requires. */
  canManage: boolean;
  /**
   * "banner" sits above the calendar and only ever appears for a connection that
   * is actually broken — a standing offer to reconnect a working one would be
   * noise in the place reserved for things that need doing. "panel" is the PMS
   * tab, where the quiet version belongs too.
   */
  placement?: "banner" | "panel";
}) {
  if (!hotelId) return null;

  const broken = BROKEN.has(status);
  const oauth = authKind === "oauth2_authorization_code";

  if (!broken && (placement === "banner" || !oauth)) return null;

  // Someone who cannot reconnect still deserves to know why prices stopped —
  // they are often the person who will go and ask the GM. They just don't get a
  // button that would answer with a 403.
  if (!canManage) {
    if (!broken) return null;
    return (
      <div className="rounded border border-amber-500/40 bg-amber-500/5 p-4">
        <h3 className="text-sm font-semibold text-amber-200">
          MAYA has lost its connection to {displayName}
        </h3>
        <p className="mt-1 text-sm text-amber-100/80">
          Prices aren&apos;t updating while this is down. Ask this property&apos;s General Manager or
          Hotel Admin to reconnect it — it takes them one click.
        </p>
      </div>
    );
  }

  if (!oauth) {
    return (
      <div className="rounded border border-amber-500/40 bg-amber-500/5 p-4">
        <h3 className="text-sm font-semibold text-amber-200">
          {displayName} needs its keys re-entered
        </h3>
        <p className="mt-1 text-sm text-amber-100/80">
          {displayName} connects with API keys from your own {displayName} dashboard rather than a
          login, so this one can&apos;t be repaired from here. Send us a message and we&apos;ll walk
          through it — it takes a couple of minutes.
        </p>
      </div>
    );
  }

  const href = `/api/pms/${pmsType}/connect?hotelId=${encodeURIComponent(hotelId)}`;

  if (!broken) {
    return (
      <a
        href={href}
        className="inline-block text-xs text-slate-400 underline-offset-4 transition hover:text-slate-300 hover:underline"
      >
        Reconnect {displayName}
      </a>
    );
  }

  return (
    <div className="rounded border border-amber-500/40 bg-amber-500/5 p-4">
      <h3 className="text-sm font-semibold text-amber-200">
        MAYA has lost its connection to {displayName}
      </h3>
      <p className="mt-1 max-w-2xl text-sm text-amber-100/80">
        Your prices aren&apos;t updating while this is down. Reconnecting takes one click and sends
        you to {displayName} to confirm — your rules, history and settings are all untouched.
      </p>
      <a
        href={href}
        className="mt-3 inline-block rounded bg-amber-500 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-amber-400"
      >
        Reconnect {displayName}
      </a>
    </div>
  );
}
