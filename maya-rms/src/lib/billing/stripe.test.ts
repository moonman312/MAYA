/**
 * The price cache has to expire. A reprice moves the lookup_key onto a NEW
 * price and archives the old one, so a warm process still holding the archived
 * id fails every checkout it serves until it happens to recycle — while cold
 * ones succeed, which reads as a flake rather than a rotation. These pin that
 * the cache answers from memory inside the window and asks Stripe again after
 * it. The cache is module state, so each test takes a fresh import and spies
 * on that instance's list call — nothing leaves the process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TTL_MS = 5 * 60 * 1000;

const listing = (ids: string[]) => ({ data: ids.map((id) => ({ id })) }) as never;

async function freshModule() {
  vi.resetModules();
  const mod = await import("./stripe");
  const list = vi.spyOn(mod.stripeClient().prices, "list");
  return { priceIdFor: mod.priceIdFor, list };
}

beforeEach(() => {
  vi.useFakeTimers();
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("priceIdFor", () => {
  it("resolves by lookup_key once and serves repeats from the cache", async () => {
    const { priceIdFor, list } = await freshModule();
    list.mockResolvedValue(listing(["price_1"]));
    expect(await priceIdFor("month")).toBe("price_1");
    expect(await priceIdFor("month")).toBe("price_1");
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("keeps answering from memory inside the window", async () => {
    const { priceIdFor, list } = await freshModule();
    list.mockResolvedValue(listing(["price_1"]));
    await priceIdFor("month");
    vi.advanceTimersByTime(TTL_MS - 1000);
    expect(await priceIdFor("month")).toBe("price_1");
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("asks Stripe again once the entry has aged out", async () => {
    const { priceIdFor, list } = await freshModule();
    list.mockResolvedValueOnce(listing(["price_old"]));
    expect(await priceIdFor("month")).toBe("price_old");

    // The rotation: bootstrap archived price_old and moved the key onward.
    list.mockResolvedValueOnce(listing(["price_new"]));
    vi.advanceTimersByTime(TTL_MS + 1);
    expect(await priceIdFor("month")).toBe("price_new");
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("caches each interval on its own", async () => {
    const { priceIdFor, list } = await freshModule();
    list.mockResolvedValueOnce(listing(["price_m"])).mockResolvedValueOnce(listing(["price_y"]));
    expect(await priceIdFor("month")).toBe("price_m");
    expect(await priceIdFor("year")).toBe("price_y");
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("names the missing lookup_key rather than falling back to another price", async () => {
    const { priceIdFor, list } = await freshModule();
    list.mockResolvedValue(listing([]));
    await expect(priceIdFor("month")).rejects.toThrow("maya_rooms_monthly_v1");
  });
});
