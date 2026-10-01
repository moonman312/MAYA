/**
 * Reading a Cloudbeds property's time zone, currency and room types in the
 * shapes Cloudbeds documents (API reference v1.2 and v1.3, getHotelDetails,
 * getHotels and getRoomTypes):
 *
 *   getHotelDetails  data.propertyCurrency is an object { currencyCode, ... };
 *                    there is no time zone field at all.
 *   getHotels        data[].propertyTimezone, and data[].propertyCurrency as
 *                    an array of { currencyCode, ... }.
 *   getRoomTypes     pages, 20 to a page unless pageSize says otherwise.
 *
 * Both pilots were saved with UTC because the time zone was looked for on
 * getHotelDetails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const limiter = vi.hoisted(() => ({
  acquire: vi.fn(async () => {}),
  record: vi.fn(),
}));
vi.mock("../../../supabase/functions/_shared/pms/rate-limit.ts", () => limiter);

import {
  cloudbedsCurrencyCode,
  cloudbedsGetHotelDetails,
  cloudbedsListProperties,
  cloudbedsListRoomTypes,
  cloudbedsTimeZone,
} from "../../../supabase/functions/_shared/cloudbeds/client";
import { parseCloudbedsRoomTypes } from "../../../supabase/functions/_shared/cloudbeds/etl";

const CREDS = {
  accessToken: "cbat_test",
  tokenType: "Bearer",
  baseUrl: "https://api.test",
  propertyId: "317001",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status });
}

/** getHotelDetails as documented: the currency an object, no time zone. */
const DETAILS = {
  success: true,
  data: {
    propertyID: "317001",
    organizationID: "9001",
    propertyName: "Juniper Lodge",
    propertyType: "Hotel",
    propertyCurrency: {
      currencyCode: "USD",
      currencySymbol: "$",
      currencyPosition: "before",
      currencyDecimalSeparator: ".",
      currencyThousandsSeparator: ",",
    },
    propertyPrimaryLanguage: "en",
    propertyAddress: {
      propertyAddress1: "1 Harbour Road",
      propertyCity: "Austin",
      propertyState: "TX",
      propertyZip: "78701",
      propertyCountry: "US",
    },
  },
};

/** getHotels as documented: the time zone here, the currency an array. */
const hotels = (entries: Array<{ id: string; tz?: string; currency?: string }>) => ({
  success: true,
  data: entries.map((e) => ({
    propertyID: e.id,
    organizationID: "9001",
    propertyName: `Property ${e.id}`,
    propertyTimezone: e.tz,
    propertyCurrency: e.currency ? [{ currencyCode: e.currency, currencySymbol: "$", currencyPosition: "before" }] : [],
  })),
  count: entries.length,
  total: entries.length,
});

function world(answer: (method: string, url: URL) => Response) {
  const urls: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input);
      urls.push(url);
      return answer(url.pathname.split("/").pop() ?? "", url);
    }),
  );
  return urls;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a property's details", () => {
  it("takes the time zone from getHotels and the currency from getHotelDetails, as Cloudbeds documents them", async () => {
    const urls = world((method) =>
      method === "getHotelDetails" ? json(200, DETAILS) : json(200, hotels([{ id: "317001", tz: "America/Chicago", currency: "USD" }])),
    );

    expect(await cloudbedsGetHotelDetails(CREDS)).toEqual({
      externalPropertyId: "317001",
      name: "Juniper Lodge",
      timezone: "America/Chicago",
      currency: "USD",
    });
    // getHotels is asked about this property only.
    const getHotels = urls.find((u) => u.pathname === "/getHotels")!;
    expect(Object.fromEntries(getHotels.searchParams)).toEqual({ propertyIDs: "317001" });
  });

  it("never takes another property's time zone on a group grant", async () => {
    world((method) =>
      method === "getHotelDetails"
        ? json(200, DETAILS)
        : json(200, hotels([{ id: "317002", tz: "Europe/London", currency: "GBP" }, { id: "317001", tz: "America/Denver" }])),
    );
    expect((await cloudbedsGetHotelDetails(CREDS)).timezone).toBe("America/Denver");

    world((method) => (method === "getHotelDetails" ? json(200, DETAILS) : json(200, hotels([{ id: "317002", tz: "Europe/London" }]))));
    expect((await cloudbedsGetHotelDetails(CREDS)).timezone).toBeNull();
  });

  it("answers without a time zone when getHotels fails, rather than failing the details", async () => {
    world((method) => (method === "getHotelDetails" ? json(200, DETAILS) : json(500, { success: false, message: "upstream" })));
    expect(await cloudbedsGetHotelDetails(CREDS)).toEqual({
      externalPropertyId: "317001",
      name: "Juniper Lodge",
      timezone: null,
      currency: "USD",
    });
  });

  it("takes the currency from getHotels when getHotelDetails has none", async () => {
    world((method) =>
      method === "getHotelDetails"
        ? json(200, { success: true, data: { propertyName: "Harbour Inn" } })
        : json(200, hotels([{ id: "317001", tz: "America/Halifax", currency: "cad" }])),
    );
    expect(await cloudbedsGetHotelDetails(CREDS)).toMatchObject({ timezone: "America/Halifax", currency: "CAD" });
  });

  it("ignores a time zone the runtime does not know", async () => {
    world((method) =>
      method === "getHotelDetails" ? json(200, DETAILS) : json(200, hotels([{ id: "317001", tz: "Central Time (US & Canada)" }])),
    );
    expect((await cloudbedsGetHotelDetails(CREDS)).timezone).toBeNull();
  });

  it("reads each listed property's time zone and currency off getHotels", async () => {
    world(() => json(200, hotels([{ id: "317001", tz: "America/Chicago", currency: "USD" }, { id: "317002" }])));
    expect(await cloudbedsListProperties({ accessToken: "t", tokenType: "Bearer", baseUrl: "https://api.test" })).toEqual([
      { propertyId: "317001", name: "Property 317001", timezone: "America/Chicago", currency: "USD" },
      { propertyId: "317002", name: "Property 317002", timezone: null, currency: null },
    ]);
  });

  it("reads a currency in every shape Cloudbeds uses, and a time zone only when it is real", () => {
    expect(cloudbedsCurrencyCode({ currencyCode: "eur" })).toBe("EUR");
    expect(cloudbedsCurrencyCode([{ currencyCode: "GBP" }, { currencyCode: "USD" }])).toBe("GBP");
    expect(cloudbedsCurrencyCode(" usd ")).toBe("USD");
    expect(cloudbedsCurrencyCode([])).toBeNull();
    expect(cloudbedsCurrencyCode({})).toBeNull();
    expect(cloudbedsTimeZone("America/Chicago")).toBe("America/Chicago");
    expect(cloudbedsTimeZone(" Europe/Paris ")).toBe("Europe/Paris");
    // Cloudbeds' own name is kept: never the runtime's older alias for it.
    expect(cloudbedsTimeZone("Asia/Kolkata")).toBe("Asia/Kolkata");
    expect(cloudbedsTimeZone("America/Indiana/Indianapolis")).toBe("America/Indiana/Indianapolis");
    expect(cloudbedsTimeZone("Europe/Kyiv")).toBe("Europe/Kyiv");
    expect(cloudbedsTimeZone("US/Central")).toBe("US/Central");
    // Only the case is mended.
    expect(cloudbedsTimeZone("america/chicago")).toBe("America/Chicago");
    expect(cloudbedsTimeZone("")).toBeNull();
    expect(cloudbedsTimeZone("Not/AZone")).toBeNull();
    expect(cloudbedsTimeZone(-6)).toBeNull();
  });
});

describe("the room type list", () => {
  const types = (from: number, n: number, propertyID = "317001") =>
    Array.from({ length: n }, (_, i) => ({
      roomTypeID: `RT${from + i}`,
      propertyID,
      roomTypeName: `Room ${from + i}`,
      roomTypeNameShort: "RM",
    }));

  it("asks for 100 at a time and is complete only once an empty page follows the rows", async () => {
    const urls = world((_, url) => json(200, { success: true, data: Number(url.searchParams.get("pageNumber")) === 1 ? types(1, 8) : [] }));
    const list = await cloudbedsListRoomTypes(CREDS);
    expect(list.complete).toBe(true);
    expect(list.roomTypes).toHaveLength(8);
    expect(urls).toHaveLength(2);
    expect(Object.fromEntries(urls[0].searchParams)).toEqual({ propertyID: "317001", pageNumber: "1", pageSize: "100" });
    expect(urls[1].searchParams.get("pageNumber")).toBe("2");
  });

  it("reads every page of a property with more types than a page holds", async () => {
    const urls = world((_, url) => {
      const page = Number(url.searchParams.get("pageNumber"));
      return json(200, { success: true, data: page === 1 ? types(1, 100) : page === 2 ? types(101, 7) : [] });
    });
    const list = await cloudbedsListRoomTypes(CREDS);
    expect(list).toMatchObject({ complete: true });
    expect(list.roomTypes).toHaveLength(107);
    expect(urls).toHaveLength(3);
  });

  it("reads past a short page, so a host that pages by its own number (50, say) is read to the end", async () => {
    const pages: Record<number, unknown[]> = { 1: types(1, 50), 2: types(51, 50), 3: types(101, 7) };
    world((_, url) => json(200, { success: true, data: pages[Number(url.searchParams.get("pageNumber"))] ?? [] }));
    const list = await cloudbedsListRoomTypes(CREDS);
    expect(list).toMatchObject({ complete: true });
    expect(list.roomTypes).toHaveLength(107);
  });

  it("keeps what it read and calls the list not complete when a later page fails, never failing the read", async () => {
    // A host that answers a page past the end with an error, or with success false.
    for (const past of [json(404, { success: false, message: "No results" }), json(200, { success: false, message: "Invalid page" })]) {
      world((_, url) => (Number(url.searchParams.get("pageNumber")) === 1 ? json(200, { success: true, data: types(1, 20) }) : past));
      const list = await cloudbedsListRoomTypes(CREDS);
      expect(list.complete).toBe(false);
      expect(list.roomTypes).toHaveLength(20);
    }
  });

  it("does not take a page of Cloudbeds' default 20 as the end: it may be a host that ignores pageSize", async () => {
    const pages: Record<number, unknown[]> = { 1: types(1, 20), 2: types(21, 5) };
    world((_, url) => json(200, { success: true, data: pages[Number(url.searchParams.get("pageNumber"))] ?? [] }));
    const list = await cloudbedsListRoomTypes(CREDS);
    expect(list).toMatchObject({ complete: true });
    expect(list.roomTypes).toHaveLength(25);

    // Exactly 20 types: the empty page after them says the list is done.
    world((_, url) => json(200, { success: true, data: Number(url.searchParams.get("pageNumber")) === 1 ? types(1, 20) : [] }));
    expect(await cloudbedsListRoomTypes(CREDS)).toMatchObject({ complete: true });
  });

  it("is not complete when the host answers every page with the same rows, or a page is not a list", async () => {
    world(() => json(200, { success: true, data: types(1, 20) }));
    const repeated = await cloudbedsListRoomTypes(CREDS);
    expect(repeated.complete).toBe(false);
    expect(repeated.roomTypes).toHaveLength(20);

    world(() => json(200, { success: true, data: { roomTypeID: "RT1" } }));
    expect(await cloudbedsListRoomTypes(CREDS)).toEqual({ roomTypes: [], complete: false });
  });

  it("holds the list to the total when the answer gives one", async () => {
    world(() => json(200, { success: true, data: types(1, 3), total: 5 }));
    expect((await cloudbedsListRoomTypes(CREDS)).complete).toBe(false);

    world(() => json(200, { success: true, data: types(1, 3), total: 3 }));
    expect((await cloudbedsListRoomTypes(CREDS)).complete).toBe(true);
  });

  it("leaves out another property's types on a group grant", async () => {
    world(() => json(200, { success: true, data: [...types(1, 2), ...types(50, 2, "317002")] }));
    expect((await cloudbedsListRoomTypes(CREDS)).roomTypes.map((t) => t.roomTypeID)).toEqual(["RT1", "RT2"]);
  });

  it("throws when Cloudbeds refuses, so a failed read is never a list", async () => {
    world(() => json(500, { success: false, message: "upstream" }));
    await expect(cloudbedsListRoomTypes(CREDS)).rejects.toThrow(/getRoomTypes failed/);
  });
});

describe("room type names", () => {
  it("keeps the full name for display, never the short code two types can share", () => {
    const parsed = parseCloudbedsRoomTypes(
      [
        { roomTypeID: "11", roomTypeName: "Harbour Double", roomTypeNameShort: "DBL", roomTypeUnits: 6 },
        { roomTypeID: "12", roomTypeName: "Harbour Double Deluxe", roomTypeNameShort: "DBL", roomTypeUnits: 4 },
        // No name at all: the code is better than nothing.
        { roomTypeID: "13", roomTypeNameShort: "TWN", roomTypeUnits: 2 },
      ],
      10,
    );
    expect(parsed.map((p) => [p.name, p.display_name])).toEqual([
      ["Harbour Double", "Harbour Double"],
      ["Harbour Double Deluxe", "Harbour Double Deluxe"],
      ["TWN", "TWN"],
    ]);
  });
});
