/**
 * Sending an invitation from the Team page.
 *
 * When it fails, the reason is written for us (it names the email and sign-in
 * services and quotes their answers), so it goes to the server log and the
 * page gets a plain sentence. When it works, the page is told whether an email
 * really went out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const HOTEL = "hotel-1";

const state = vi.hoisted(() => ({
  inviteUserToHotel: vi.fn(),
}));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => ({}),
  isAdminConfigured: () => true,
}));
vi.mock("@/lib/rate-limit", () => ({ enforceRateLimit: async () => null }));
vi.mock("@/lib/require-supabase-hotel", () => ({
  requireSupabaseHotelRank: async () => ({
    ok: true,
    hotelId: HOTEL,
    supabase: { auth: { getUser: async () => ({ data: { user: { email: "gm@inn.example" } } }) } },
  }),
  hasHotelRank: async () => false,
}));
vi.mock("@/lib/account/team", () => ({
  loadTeam: async () => ({
    members: [],
    invites: [],
    seats: { used: 1, limit: 4, remaining: 3, full: false },
    rooms: 24,
  }),
}));
vi.mock("@/lib/admin/memberships", () => ({ inviteUserToHotel: state.inviteUserToHotel }));

const { POST } = await import("./route");

const invite = () =>
  POST(
    new Request("https://maya.test/api/account/team", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "night@inn.example", role: "viewer" }),
    }),
  );

let logged: string[] = [];

beforeEach(() => {
  logged = [];
  vi.spyOn(console, "error").mockImplementation((line: unknown) => {
    logged.push(String(line));
  });
  state.inviteUserToHotel.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/account/team", () => {
  it("answers a failed send with a plain sentence and logs the detail", async () => {
    state.inviteUserToHotel.mockRejectedValue(
      new Error("Resend send failed: HTTP 403 — The maya-rms.com domain is not verified"),
    );
    const res = await invite();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Could not send that invitation. Try again in a minute.");
    expect(body.error).not.toMatch(/Resend|Supabase|HTTP/);
    expect(logged.join("\n")).toContain("Resend send failed: HTTP 403");
  });

  it("does the same when the sign-in service refuses the link", async () => {
    state.inviteUserToHotel.mockRejectedValue(
      new Error("Supabase invite link generation failed: Database error saving new user"),
    );
    const body = (await (await invite()).json()) as { error: string };
    expect(body.error).toBe("Could not send that invitation. Try again in a minute.");
    expect(logged.join("\n")).toContain("Supabase invite link generation failed");
  });

  it("tells the page whether an email went out", async () => {
    state.inviteUserToHotel.mockResolvedValue({ inviteSent: false, pendingId: "p-1", existingUser: true });
    const res = await invite();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, inviteSent: false, pendingId: "p-1", existingUser: true });
  });
});
