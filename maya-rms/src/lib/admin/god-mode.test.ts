/**
 * The app side of God Mode: everything is asked of the database and any
 * doubt reads as off. requireGodMode refuses an admin without a window, with
 * an expired one (the database answers inactive), or without a code (aal1),
 * and lets a live window through; recordIfSupport writes a support_changes
 * row only for a non-member admin in God Mode, never for a member.
 */
import { describe, expect, it, vi } from "vitest";
import { fakeSupabase } from "@/lib/engine/fake-supabase.test";

vi.mock("server-only", () => ({}));

const { GOD_MODE_OFF, godModeStatus, platformAdminIds, recordIfSupport, recordSupportChange, requireGodMode } =
  await import("./god-mode");

type Status = Record<string, unknown>;

/** A session client whose god_mode_* answers are set per test. */
function ssrWith(opts: { status?: Status; statusError?: { code: string; message: string }; active?: boolean; memberships?: { hotel_id: string; user_id: string; status: string }[] }) {
  return fakeSupabase(
    { hotel_memberships: opts.memberships ?? [] },
    {
      rpc: (fn) => {
        if (fn === "god_mode_status") {
          if (opts.statusError) throw new Error("unused");
          return opts.status ?? { admin: false, aal: "aal1", active: false };
        }
        if (fn === "god_mode_active") return opts.active === true;
        return null;
      },
    },
  );
}

const live: Status = { admin: true, aal: "aal2", active: true, session_id: "s-1", started_at: "2026-09-29T10:00:00Z", expires_at: "2026-09-29T10:30:00Z" };

describe("godModeStatus", () => {
  it("reads the database's answer", async () => {
    expect(await godModeStatus(ssrWith({ status: live }).client)).toEqual({
      admin: true,
      aal: "aal2",
      active: true,
      sessionId: "s-1",
      startedAt: "2026-09-29T10:00:00Z",
      expiresAt: "2026-09-29T10:30:00Z",
    });
  });

  it("reads as off when the call fails or answers nothing", async () => {
    const failing = fakeSupabase({}, {
      rpc: () => {
        throw new Error("no such function");
      },
    });
    await expect(godModeStatus(failing.client)).rejects.toThrow();
    const empty = fakeSupabase({}, { rpc: () => null });
    expect(await godModeStatus(empty.client)).toMatchObject({ admin: false, active: false, sessionId: null });
  });
});

describe("requireGodMode", () => {
  it("refuses an admin with no window, with an expired one, and without a code, in one plain sentence", async () => {
    for (const status of [
      { ...live, active: false, session_id: null, started_at: null, expires_at: null },
      // The database closes an expired window before answering: inactive, no session.
      { ...live, active: false, session_id: null },
      { ...live, aal: "aal1", active: false },
    ]) {
      const out = await requireGodMode(ssrWith({ status }).client);
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.response.status).toBe(403);
        expect(await out.response.json()).toEqual({ error: GOD_MODE_OFF });
      }
    }
    expect(GOD_MODE_OFF).toBe("God Mode is off. Turn it on from the Command Center to change this property.");
  });

  it("refuses a customer", async () => {
    const out = await requireGodMode(ssrWith({ status: { admin: false, aal: "aal2", active: false } }).client);
    expect(out.ok).toBe(false);
  });

  it("lets an admin with a live window through, with the window", async () => {
    const out = await requireGodMode(ssrWith({ status: live }).client);
    expect(out).toEqual({ ok: true, session: { id: "s-1", startedAt: "2026-09-29T10:00:00Z", expiresAt: "2026-09-29T10:30:00Z" } });
  });
});

describe("recordSupportChange", () => {
  it("writes the row with the service role and never throws when that fails", async () => {
    const admin = fakeSupabase();
    await recordSupportChange(admin.client, {
      sessionId: "s-1",
      userId: "admin-1",
      hotelId: "h9",
      tableName: "hotel_settings",
      rowId: "h9",
      op: "update",
      before: { simulation_mode: true },
      after: { simulation_mode: false },
      summary: "Took pricing live.",
    });
    expect(admin.tables.support_changes).toEqual([
      expect.objectContaining({
        session_id: "s-1",
        user_id: "admin-1",
        hotel_id: "h9",
        table_name: "hotel_settings",
        row_id: "h9",
        op: "update",
        before: { simulation_mode: true },
        after: { simulation_mode: false },
        summary: "Took pricing live.",
      }),
    ]);

    const broken = fakeSupabase({}, { fault: () => ({ code: "42P01", message: "no table" }) });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      recordSupportChange(broken.client, { sessionId: null, userId: "a", hotelId: "h", tableName: "t", op: "insert", summary: "x" }),
    ).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });
});

describe("recordIfSupport", () => {
  const change = { userId: "admin-1", hotelId: "h9", tableName: "room_types", rowId: "rt-1", op: "update" as const, summary: "Changed the room type." };

  it("records a non-member admin's change in God Mode, with the open window", async () => {
    const ssr = ssrWith({ status: live, active: true });
    const admin = fakeSupabase();
    expect(await recordIfSupport(ssr.client, admin.client, change)).toBe(true);
    expect(admin.tables.support_changes).toEqual([expect.objectContaining({ session_id: "s-1", user_id: "admin-1", hotel_id: "h9", summary: "Changed the room type." })]);
  });

  it("records nothing outside God Mode, and stops after one cheap RPC", async () => {
    const ssr = ssrWith({ status: { ...live, active: false }, active: false });
    const admin = fakeSupabase();
    expect(await recordIfSupport(ssr.client, admin.client, change)).toBe(false);
    expect(admin.tables.support_changes ?? []).toEqual([]);
    expect(ssr.calls.map((c) => c.table)).toEqual(["rpc:god_mode_active"]);
  });

  it("records nothing for a member of the property: their change is their own", async () => {
    const ssr = ssrWith({
      status: live,
      active: true,
      memberships: [{ hotel_id: "h9", user_id: "admin-1", status: "active" }],
    });
    const admin = fakeSupabase();
    expect(await recordIfSupport(ssr.client, admin.client, change)).toBe(false);
    expect(admin.tables.support_changes ?? []).toEqual([]);
  });
});

describe("platformAdminIds", () => {
  it("picks the platform admins out of a set of user ids, and nobody when the table is out of reach", async () => {
    const admin = fakeSupabase({
      app_roles: [
        { user_id: "u-1", role: "platform_admin" },
        { user_id: "u-2", role: "platform_support" },
      ],
    });
    expect(await platformAdminIds(admin.client, ["u-1", "u-2", "u-3", "u-1"])).toEqual(new Set(["u-1"]));
    expect(await platformAdminIds(admin.client, [])).toEqual(new Set());
    const locked = fakeSupabase({}, { fault: () => ({ code: "42501", message: "permission denied" }) });
    expect(await platformAdminIds(locked.client, ["u-1"])).toEqual(new Set());
  });
});
