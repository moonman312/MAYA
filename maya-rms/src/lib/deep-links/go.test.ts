import { describe, expect, it } from "vitest";
import { resolveGo, type GoDeps, type GoRequest } from "@/lib/deep-links/go";
import { registry } from "@/lib/deep-links";

const A = "0b0c8a6e-3c1d-4d8e-9f2a-6a1b2c3d4e5f";
const B = "1b0c8a6e-3c1d-4d8e-9f2a-6a1b2c3d4e5f";

function deps(over: Partial<GoDeps> & { role?: string | null } = {}): GoDeps {
  const { role = "hotel_admin", ...rest } = over;
  return {
    configured: true,
    userId: async () => "user-1",
    accessibleHotelIds: async () => [A, B],
    activeHotelId: async () => A,
    roleOn: async () => role,
    isPlatformAdmin: async () => false,
    hasUnpaidProperties: async () => false,
    ...rest,
  };
}

function req(destination: string, q = "", over: Partial<GoRequest> = {}): GoRequest {
  return { destination, search: new URLSearchParams(q), fetchSite: "cross-site", prefetch: false, ...over };
}

describe("/go", () => {
  it("sends a signed-in owner to the app's own address for the place", async () => {
    const r = await resolveGo(req("rules.new", "percent=10&name=Nearly+full&occupancy=gt85&direction=increase&junk=1"), deps());
    expect(r).toEqual({
      location: "/?tab=rules&panel=builder&dl=rules.new&name=Nearly+full&occupancy=gt85&direction=increase&percent=10",
      setHotel: null,
    });
  });

  it("sends a signed-out visitor through sign-in with the clean link as next", async () => {
    const r = await resolveGo(req("rules.new", "name=Nearly+full&percent=10&evil=https://x"), deps({ userId: async () => null }));
    expect(r.location).toBe(`/login?next=${encodeURIComponent("/go/rules.new?name=Nearly+full&percent=10")}`);
  });

  it("carries the property through sign-in only when MAYA made the click", async () => {
    const out = deps({ userId: async () => null });
    expect((await resolveGo(req("calendar", `hotel=${A}`), out)).location).toBe(`/login?next=${encodeURIComponent("/go/calendar")}`);
    expect((await resolveGo(req("calendar", `hotel=${A}`, { fetchSite: "same-origin" }), out)).location).toBe(
      `/login?next=${encodeURIComponent(`/go/calendar?hotel=${A}`)}`,
    );
  });

  it("switches property only when trusted, not a prefetch, and the person can open it", async () => {
    const same = { fetchSite: "same-origin" };
    expect((await resolveGo(req("calendar", `hotel=${B}`, same), deps())).setHotel).toBe(B);
    expect((await resolveGo(req("calendar", `hotel=${B}`, { fetchSite: "none" }), deps())).setHotel).toBe(B);
    expect((await resolveGo(req("calendar", `hotel=${B}`), deps())).setHotel).toBeNull();
    expect((await resolveGo(req("calendar", `hotel=${B}`, { ...same, prefetch: true }), deps())).setHotel).toBeNull();
    const other = "2b0c8a6e-3c1d-4d8e-9f2a-6a1b2c3d4e5f";
    expect((await resolveGo(req("calendar", `hotel=${other}`, same), deps())).setHotel).toBeNull();
    // the property never travels on into the app's address
    expect((await resolveGo(req("calendar", `hotel=${B}`, same), deps())).location).toBe("/?tab=calendar&dl=calendar");
  });

  it("sends someone with no property yet to the app's home", async () => {
    expect((await resolveGo(req("rules.new"), deps({ activeHotelId: async () => null }))).location).toBe("/");
  });

  it("reroutes a Viewer from the rule builder to the Rules tab with a note, keeping what that place takes", async () => {
    const r = await resolveGo(req("rules.new", "name=x&percent=10"), deps({ role: "viewer" }));
    expect(r.location).toBe("/?tab=rules&dl=rules.list&note=role-rules");
    const s = await resolveGo(req("suggestions"), deps({ role: "viewer" }));
    expect(s.location).toBe("/?tab=rules&dl=rules.list&note=role-suggestions");
  });

  it("lets a platform admin through without a membership", async () => {
    const r = await resolveGo(req("rules.new", "percent=10"), deps({ role: null, isPlatformAdmin: async () => true }));
    expect(r.location).toContain("dl=rules.new");
  });

  it("keeps the Team page for someone below the bar, which explains itself", async () => {
    expect((await resolveGo(req("team"), deps({ role: "viewer" }))).location).toBe("/account/team?dl=team");
  });

  it("drops an invite role the person cannot grant", async () => {
    expect((await resolveGo(req("team.invite", "role=hotel_admin"), deps({ role: "general_manager" }))).location).toBe(
      "/account/team?focus=invite&dl=team.invite",
    );
    expect((await resolveGo(req("team.invite", "role=viewer"), deps({ role: "general_manager" }))).location).toBe(
      "/account/team?focus=invite&dl=team.invite&role=viewer",
    );
  });

  it("sends an owner who still owes a group checkout home instead of the questions", async () => {
    expect((await resolveGo(req("questions"), deps({ hasUnpaidProperties: async () => true }))).location).toBe("/?dl=home");
    expect((await resolveGo(req("questions"), deps())).location).toBe("/onboarding/questions?dl=questions");
  });

  it("falls back safely for unknown destinations and missing nights", async () => {
    expect((await resolveGo(req("../admin"), deps())).location).toBe("/?dl=home");
    expect((await resolveGo(req("calendar.day", "roomType=" + A), deps())).location).toBe("/?tab=calendar&dl=calendar");
  });

  it("only ever answers with a same-origin path on the registry's list", async () => {
    const all = Object.keys(registry.destinations);
    for (const id of [...all, "nope", "//evil.example", "https:"]) {
      for (const d of [deps(), deps({ role: "viewer" }), deps({ userId: async () => null })]) {
        const { location } = await resolveGo(req(id, "next=//evil.example&hotel=" + A), d);
        expect(location.startsWith("/")).toBe(true);
        expect(location.startsWith("//")).toBe(false);
        const path = location.split("?")[0];
        expect(["/login", ...registry.paths]).toContain(path);
      }
    }
  });

  it("works without Supabase, for local demo mode", async () => {
    expect((await resolveGo(req("changelog", "view=all"), deps({ configured: false }))).location).toBe("/?tab=changelog&dl=changelog&view=all");
  });
});
