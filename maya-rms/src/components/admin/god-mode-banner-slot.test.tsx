/**
 * The God Mode banner costs nothing for anyone who is not a platform admin:
 * the server reads the role once and renders the banner only for an admin, so
 * a customer's browser never asks /api/admin/god-mode, and the root layout
 * (which every docs page shares) never mounts it or reads the session.
 */
import fs from "node:fs";
import path from "node:path";
import { isValidElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  configured: true,
  session: { user: { id: "user-1" } } as unknown,
  admin: false as unknown,
  rpcError: null as { message: string } | null,
  clients: 0,
  rpcs: [] as string[],
}));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => state.configured }));
vi.mock("@/utils/supabase/server", () => ({
  createClient: () => {
    state.clients += 1;
    return {
      auth: {
        getSession: async () => ({ data: { session: state.session } }),
        getUser: async () => {
          throw new Error("the slot never needs an auth round trip");
        },
      },
      rpc: async (fn: string) => {
        state.rpcs.push(fn);
        return { data: state.rpcError ? null : state.admin, error: state.rpcError };
      },
    };
  },
}));

const { GodModeBannerSlot } = await import("./god-mode-banner-slot");
const { GodModeBanner } = await import("./god-mode-banner");

const ROOT = path.resolve(__dirname, "../../..");

beforeEach(() => {
  state.configured = true;
  state.session = { user: { id: "user-1" } };
  state.admin = false;
  state.rpcError = null;
  state.clients = 0;
  state.rpcs = [];
});

const isBanner = (el: unknown) => isValidElement(el) && el.type === GodModeBanner;

describe("GodModeBannerSlot", () => {
  it("renders nothing for a customer, after one is_platform_admin read on the server", async () => {
    expect(await GodModeBannerSlot()).toBeNull();
    expect(state.rpcs).toEqual(["is_platform_admin"]);
  });

  it("renders the banner for a platform admin", async () => {
    state.admin = true;
    expect(isBanner(await GodModeBannerSlot())).toBe(true);
    expect(state.rpcs).toEqual(["is_platform_admin"]);
  });

  it("asks nothing when nobody is signed in or Supabase is not set up", async () => {
    state.session = null;
    expect(await GodModeBannerSlot()).toBeNull();
    state.configured = false;
    expect(await GodModeBannerSlot()).toBeNull();
    expect(state.rpcs).toEqual([]);
  });

  it("renders nothing when the role can't be read", async () => {
    state.rpcError = { message: "boom" };
    expect(await GodModeBannerSlot()).toBeNull();
  });

  it("reads nothing when the page already knows the role", async () => {
    expect(isBanner(await GodModeBannerSlot({ isPlatformAdmin: true }))).toBe(true);
    expect(await GodModeBannerSlot({ isPlatformAdmin: false })).toBeNull();
    expect(state.clients).toBe(0);
    expect(state.rpcs).toEqual([]);
  });
});

describe("where the banner is mounted", () => {
  const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");

  it("never in the root layout, so docs readers load none of it and the docs stay built ahead of time", () => {
    const src = read("src/app/layout.tsx");
    expect(src).not.toMatch(/GodModeBanner/);
    expect(src).not.toMatch(/next\/headers|utils\/supabase\/server|cookies\(/);
  });

  it("in every signed-in area, passing the role where the page already read it", () => {
    expect(read("src/app/page.tsx")).toMatch(/<GodModeBannerSlot isPlatformAdmin=\{isPlatformAdmin\} \/>/);
    expect(read("src/app/admin/layout.tsx")).toMatch(/<GodModeBannerSlot isPlatformAdmin \/>/);
    expect(read("src/app/onboarding/layout.tsx")).toMatch(/<GodModeBannerSlot \/>/);
    expect(read("src/app/account/layout.tsx")).toMatch(/<GodModeBannerSlot \/>/);
  });
});
