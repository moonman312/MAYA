/**
 * What /go/<destination> decides, kept apart from Next and Supabase so it can
 * be tested with plain functions. The route (src/app/go/[destination]/route.ts)
 * supplies the reads; this never writes anything. Its one side effect, the
 * active property, is returned as `setHotel` for the route to apply.
 */

import { roleRank, rolesAssignableBy } from "@/lib/roles";
import { links, type ParsedLink } from "@/lib/deep-links";

export type GoRequest = {
  destination: string;
  search: URLSearchParams;
  /** Sec-Fetch-Site, null when the browser sent none. */
  fetchSite: string | null;
  /** A prefetch or a link preview, not a person clicking. */
  prefetch: boolean;
};

export type GoDeps = {
  /** Supabase is set up on this deployment (local demo mode has none). */
  configured: boolean;
  userId(): Promise<string | null>;
  /** The properties the signed-in person can open. */
  accessibleHotelIds(): Promise<string[]>;
  /** The active property as the rest of the app resolves it (cookie, then first). */
  activeHotelId(): Promise<string | null>;
  /** Their best role on that property, or null. */
  roleOn(hotelId: string): Promise<string | null>;
  isPlatformAdmin(): Promise<boolean>;
  /** Group properties from the Marketplace still waiting for their checkout. */
  hasUnpaidProperties(): Promise<boolean>;
};

export type GoResult = {
  /** Same-origin path and query to send the browser to. */
  location: string;
  /** Set the active property cookie to this before redirecting. */
  setHotel: string | null;
};

function keepOnly(parsed: ParsedLink, dest: string): ParsedLink {
  const allowed = links.destination(dest).params;
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed.params)) if (allowed.includes(k)) params[k] = v;
  return { ...parsed, dest, params, query: links.canonicalQuery(dest, params) };
}

export async function resolveGo(req: GoRequest, deps: GoDeps): Promise<GoResult> {
  let parsed = links.parseLink(req.destination, req.search);
  const trusted = req.fetchSite === null || req.fetchSite === "same-origin" || req.fetchSite === "none";

  if (!deps.configured) return { location: links.internalHref(parsed), setHotel: null };

  const userId = await deps.userId();
  if (!userId) {
    // The property never travels through sign-in: the hop back from the
    // sign-in page is same-origin, so anyone could launder a switch through
    // it with a hand-made /login?next=. After signing in, the person lands on
    // the place on their active property.
    const next = links.goHref(parsed.dest, parsed.params);
    return { location: `/login?next=${encodeURIComponent(next)}`, setHotel: null };
  }

  let active: string | null = null;
  let setHotel: string | null = null;
  const wanted = parsed.gate.hotel;
  if (wanted && trusted && !req.prefetch) {
    const ids = await deps.accessibleHotelIds();
    if (ids.includes(wanted)) {
      active = wanted;
      setHotel = wanted;
    }
  }
  if (!active) active = await deps.activeHotelId();
  // No property yet: the app's own home decides (onboarding, or Command Center).
  if (!active) return { location: "/", setHotel: null };

  let note: string | null = null;
  const dest = links.destination(parsed.dest);
  const needsRole = Boolean(dest.role) || parsed.dest === "team.invite";
  let role: string | null = null;
  let admin = false;
  if (needsRole) {
    role = await deps.roleOn(active);
    admin = await deps.isPlatformAdmin();
  }
  if (dest.role && !admin && roleRank(role ?? "") < roleRank(dest.role)) {
    if (dest.belowRole && dest.belowRole !== "page") {
      note = dest.belowRole.note;
      parsed = keepOnly(parsed, dest.belowRole.to);
    }
  }

  if (parsed.dest === "team.invite" && parsed.params.role) {
    const grantable = rolesAssignableBy(role, { isPlatformAdmin: admin }).map((r) => r.key as string);
    if (!grantable.includes(parsed.params.role)) {
      const { role: _dropped, ...rest } = parsed.params;
      void _dropped;
      parsed = { ...parsed, params: rest };
    }
  }

  const when = links.destination(parsed.dest).when ?? {};
  if (when["unpaid-properties"] && (await deps.hasUnpaidProperties())) {
    parsed = keepOnly(parsed, when["unpaid-properties"].to);
  }

  return { location: links.internalHref(parsed, { note }), setHotel };
}
