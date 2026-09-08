import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  persistPropertyId,
  resolveOAuthCredentials,
} from "../../../supabase/functions/_shared/pms/oauth-credentials";
import type { SupabaseClient } from "@supabase/supabase-js";

type Secret = Record<string, unknown>;

/** A secret inside REFRESH_SKEW_MS, i.e. one that will trigger a refresh. */
function nearExpiry(accessToken: string, refreshToken: string): Secret {
  return {
    accessToken,
    refreshToken,
    tokenType: "Bearer",
    scope: "read",
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  };
}

function fresh(accessToken: string, refreshToken: string): Secret {
  return {
    accessToken,
    refreshToken,
    tokenType: "Bearer",
    scope: "read",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

function makeSupabaseStub(opts: { secret: Secret; setError?: () => string | null }) {
  const vault: { secret: Secret | null } = { secret: opts.secret };
  const writes: Secret[] = [];
  const connectionUpdates: Secret[] = [];

  const supabase = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "pms_secret_get") return { data: vault.secret, error: null };
      if (fn === "pms_secret_set") {
        const payload = args.p_secret as Secret;
        writes.push(payload);
        const msg = opts.setError?.() ?? null;
        if (msg) return { data: null, error: { message: msg } };
        vault.secret = payload;
        return { data: "vault-id", error: null };
      }
      throw new Error(`unexpected rpc: ${fn}`);
    },
    from: (name: string) => {
      const chain = {
        update: (patch: Secret) => {
          if (name === "pms_connections") connectionUpdates.push(patch);
          return chain;
        },
        eq: () => chain,
      };
      return chain;
    },
  } as unknown as SupabaseClient;

  return { supabase, vault, writes, connectionUpdates };
}

/** Token endpoint that rotates the refresh token and rejects a spent one. */
function makeRotatingVendor(initialRefreshToken: string) {
  const consumed: string[] = [];
  const live = new Set([initialRefreshToken]);
  let generation = 1;

  async function tokenEndpoint(_url: string, init?: { body?: string }): Promise<Response> {
    const sent = new URLSearchParams(String(init?.body ?? "")).get("refresh_token") ?? "";
    consumed.push(sent);
    if (!live.has(sent)) {
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }
    live.delete(sent);
    generation += 1;
    live.add(`RT${generation}`);
    return new Response(
      JSON.stringify({
        access_token: `AT${generation}`,
        refresh_token: `RT${generation}`,
        expires_in: 3600,
        token_type: "Bearer",
      }),
      { status: 200 },
    );
  }

  return { consumed, tokenEndpoint };
}

describe("resolveOAuthCredentials refresh safety", () => {
  beforeEach(() => {
    process.env.CLOUDBEDS_CLIENT_ID = "cid";
    process.env.CLOUDBEDS_CLIENT_SECRET = "csecret";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.CLOUDBEDS_CLIENT_ID;
    delete process.env.CLOUDBEDS_CLIENT_SECRET;
  });

  it("sends one refresh_token grant when two callers race the same connection", async () => {
    const vendor = makeRotatingVendor("RT1");
    vi.stubGlobal("fetch", vendor.tokenEndpoint);
    const db = makeSupabaseStub({ secret: nearExpiry("AT1", "RT1") });

    const [a, b] = await Promise.all([
      resolveOAuthCredentials(db.supabase, "hotel-race", "cloudbeds"),
      resolveOAuthCredentials(db.supabase, "hotel-race", "cloudbeds"),
    ]);

    expect(vendor.consumed).toEqual(["RT1"]);
    expect(a).toMatchObject({ accessToken: "AT2", refreshed: true });
    expect(b).toMatchObject({ accessToken: "AT2", refreshed: false });
    expect(db.vault.secret).toMatchObject({ accessToken: "AT2", refreshToken: "RT2" });
  });

  it("serves the rotated token and re-persists it when the Vault write fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const vendor = makeRotatingVendor("RT1");
    vi.stubGlobal("fetch", vendor.tokenEndpoint);
    let writesFail = true;
    const db = makeSupabaseStub({
      secret: nearExpiry("AT1", "RT1"),
      setError: () => (writesFail ? "canceling statement due to statement timeout" : null),
    });

    const first = await resolveOAuthCredentials(db.supabase, "hotel-wedge", "cloudbeds");
    expect(first).toMatchObject({ accessToken: "AT2", refreshed: true });
    // Vault still holds the token the vendor already burned.
    expect(db.vault.secret).toMatchObject({ accessToken: "AT1", refreshToken: "RT1" });
    expect(db.connectionUpdates).toEqual([
      expect.objectContaining({ status: "degraded" }),
    ]);

    writesFail = false;
    const second = await resolveOAuthCredentials(db.supabase, "hotel-wedge", "cloudbeds");

    expect(second).toMatchObject({ accessToken: "AT2" });
    expect(db.vault.secret).toMatchObject({ accessToken: "AT2", refreshToken: "RT2" });
    // The dead RT1 was never sent again, so the connection never wedged.
    expect(vendor.consumed).toEqual(["RT1"]);
  });

  it("adopts a token another process rotated instead of failing on invalid_grant", async () => {
    const db = makeSupabaseStub({ secret: nearExpiry("AT1", "RT1") });
    vi.stubGlobal("fetch", async () => {
      // The other process wrote its rotated pair while our POST was in flight.
      db.vault.secret = fresh("AT9", "RT9");
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    });

    const res = await resolveOAuthCredentials(db.supabase, "hotel-crossproc", "cloudbeds");

    expect(res).toMatchObject({ accessToken: "AT9", refreshed: false });
    expect(db.connectionUpdates).toEqual([]);
  });

  it("drops a pending rotation when another process wrote a newer access token under the same refresh token", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let writesFail = true;
    const db = makeSupabaseStub({
      secret: nearExpiry("AT1", "RT1"),
      setError: () => (writesFail ? "canceling statement due to statement timeout" : null),
    });
    // A provider that does not rotate the refresh token, so RT1 alone cannot
    // distinguish our stale pending write from someone else's fresher one.
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ access_token: "AT2", expires_in: 3600, token_type: "Bearer" }), {
          status: 200,
        }),
    );

    const first = await resolveOAuthCredentials(db.supabase, "hotel-nonrotating", "cloudbeds");
    expect(first).toMatchObject({ accessToken: "AT2", refreshed: true });

    db.vault.secret = fresh("AT5", "RT1");
    writesFail = false;
    const second = await resolveOAuthCredentials(db.supabase, "hotel-nonrotating", "cloudbeds");

    expect(second).toMatchObject({ accessToken: "AT5", refreshed: false });
    expect(db.vault.secret).toMatchObject({ accessToken: "AT5", refreshToken: "RT1" });
  });

  it("bounds the token POST with an abort signal, since it holds the connection lock", async () => {
    const db = makeSupabaseStub({ secret: nearExpiry("AT1", "RT1") });
    let init: RequestInit | undefined;
    vi.stubGlobal("fetch", async (_url: string, opts?: RequestInit) => {
      init = opts;
      return new Response(JSON.stringify({ access_token: "AT2", expires_in: 3600 }), { status: 200 });
    });

    await resolveOAuthCredentials(db.supabase, "hotel-timeout", "cloudbeds");

    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(false);
  });

  it("flags the connection for reconnect when the refresh token is genuinely dead", async () => {
    const db = makeSupabaseStub({ secret: nearExpiry("AT1", "RT1") });
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    );

    const res = await resolveOAuthCredentials(db.supabase, "hotel-dead", "cloudbeds");

    expect(res).toHaveProperty("error");
    expect((res as { error: string }).error).toMatch(/reconnect via OAuth/);
    expect(db.connectionUpdates).toEqual([expect.objectContaining({ status: "error" })]);
  });
});

describe("persistPropertyId", () => {
  beforeEach(() => {
    process.env.CLOUDBEDS_CLIENT_ID = "cid";
    process.env.CLOUDBEDS_CLIENT_SECRET = "csecret";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.CLOUDBEDS_CLIENT_ID;
    delete process.env.CLOUDBEDS_CLIENT_SECRET;
  });

  it("does not write stale tokens back over a refresh running alongside it", async () => {
    const vendor = makeRotatingVendor("RT1");
    vi.stubGlobal("fetch", vendor.tokenEndpoint);
    const db = makeSupabaseStub({ secret: nearExpiry("AT1", "RT1") });

    await Promise.all([
      resolveOAuthCredentials(db.supabase, "hotel-prop", "cloudbeds"),
      persistPropertyId(db.supabase, "hotel-prop", "cloudbeds", "prop-7"),
    ]);

    expect(db.vault.secret).toMatchObject({
      accessToken: "AT2",
      refreshToken: "RT2",
      propertyId: "prop-7",
    });
  });

  it("skips the write when the propertyId is already stored", async () => {
    const db = makeSupabaseStub({ secret: { ...fresh("AT1", "RT1"), propertyId: "prop-7" } });

    await persistPropertyId(db.supabase, "hotel-prop-noop", "cloudbeds", "prop-7");

    expect(db.writes).toEqual([]);
  });
});
