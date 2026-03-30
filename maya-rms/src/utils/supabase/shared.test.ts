import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * isSupabaseConfigured reads process.env at module load time,
 * so we need to manipulate env BEFORE each dynamic import.
 */

async function loadShared(): Promise<typeof import("./shared")> {
  vi.resetModules();
  return import("./shared");
}

describe("isSupabaseConfigured", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns false when both vars are undefined", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const { isSupabaseConfigured } = await loadShared();
    expect(isSupabaseConfigured()).toBe(false);
  });

  it("returns false when both vars are empty strings", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "";
    const { isSupabaseConfigured } = await loadShared();
    expect(isSupabaseConfigured()).toBe(false);
  });

  it("returns false for placeholder URL from .env.example", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://your-project.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.realtoken";
    const { isSupabaseConfigured } = await loadShared();
    expect(isSupabaseConfigured()).toBe(false);
  });

  it("returns false for placeholder anon key from .env.example", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abc123.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "eyJ...";
    const { isSupabaseConfigured } = await loadShared();
    expect(isSupabaseConfigured()).toBe(false);
  });

  it("returns false when key is too short", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abc123.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "short";
    const { isSupabaseConfigured } = await loadShared();
    expect(isSupabaseConfigured()).toBe(false);
  });

  it("returns false when URL is not https", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://abc123.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.realtoken";
    const { isSupabaseConfigured } = await loadShared();
    expect(isSupabaseConfigured()).toBe(false);
  });

  it("returns false when URL does not include .supabase.co", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.com";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.realtoken";
    const { isSupabaseConfigured } = await loadShared();
    expect(isSupabaseConfigured()).toBe(false);
  });

  it("returns true for valid production credentials", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abcdef123456.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSJ9.signature";
    const { isSupabaseConfigured } = await loadShared();
    expect(isSupabaseConfigured()).toBe(true);
  });

  it("accepts NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY as alternative", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abcdef123456.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSJ9.signature";
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const { isSupabaseConfigured } = await loadShared();
    expect(isSupabaseConfigured()).toBe(true);
  });

  it("returns false when only URL is set", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abcdef123456.supabase.co";
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY;
    const { isSupabaseConfigured } = await loadShared();
    expect(isSupabaseConfigured()).toBe(false);
  });
});

describe("getSupabaseEnv", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns url and key from env", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-key";
    const { getSupabaseEnv } = await loadShared();
    const env = getSupabaseEnv();
    expect(env.supabaseUrl).toBe("https://test.supabase.co");
    expect(env.supabasePublishableKey).toBe("test-key");
  });
});
