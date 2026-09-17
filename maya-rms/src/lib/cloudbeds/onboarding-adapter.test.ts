/**
 * The history import's page pull.
 *
 * Normally getReservationsWithRateDetails, windowed by check-out date: one call
 * per page, cursor = page number. A property that refuses rate details falls
 * back to the getReservations list, one status and one page at a time. What
 * matters is that windows tile with the live sync without a gap or a double,
 * that each room gets its own type and nightly rate, that a killed run resumes
 * on the right page (including a cursor the list-only deploy saved), and that
 * nothing about a guest reaches a row or a log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const client = vi.hoisted(() => {
  class CloudbedsHttpError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly path: string,
    ) {
      super(message);
      this.name = "CloudbedsHttpError";
    }
  }
  return {
    CloudbedsHttpError,
    pages: {} as Record<string, Record<string, unknown>[][]>,
    cloudbedsDiscoverPropertyId: vi.fn(),
    cloudbedsGetHotelDetails: vi.fn(),
    cloudbedsListProperties: vi.fn(),
    cloudbedsGetRoomTypes: vi.fn(),
    cloudbedsGetReservationsPage: vi.fn(),
    cloudbedsGetReservationsWithRateDetailsPage: vi.fn(),
  };
});

vi.mock("../../../supabase/functions/_shared/cloudbeds/client.ts", () => client);
vi.mock("../../../supabase/functions/_shared/cloudbeds/request-log.ts", () => ({
  installCloudbedsRequestLogging: vi.fn(),
}));
vi.mock("../../../supabase/functions/_shared/pms/oauth-credentials.ts", () => ({
  resolveOAuthCredentials: vi.fn(),
  persistPropertyId: vi.fn(),
}));

import {
  cloudbedsHistoryQuery,
  createCloudbedsOnboardingAdapter,
} from "../../../supabase/functions/_shared/cloudbeds/onboarding-adapter";
import {
  cloudbedsRateDetailsToDetail,
  parseCloudbedsHistoryRateDetails,
  parseCloudbedsReservationDetail,
} from "../../../supabase/functions/_shared/cloudbeds/etl";
import { historicalWindow } from "../../../supabase/functions/_shared/onboarding/worker-core";
import type {
  AdapterCursor,
  AdapterReservationRow,
} from "../../../supabase/functions/_shared/pms/onboarding-adapter";

type Json = Record<string, unknown>;

const supabase = {
  from: () => {
    const q = {
      select: () => q,
      eq: () => q,
      maybeSingle: async () => ({ data: { base_url: null }, error: null }),
    };
    return q;
  },
} as unknown as SupabaseClient;

const WINDOW = { from: "2024-01-01", to: "2024-12-31" };
const GUEST = "Placeholder Guestname";

/** The live sync's anchor: its check-in window starts here, history ends the day before. */
const ANCHOR = "2026-06-26";

function listBooking(id: string, status: string) {
  return { reservationID: id, status, startDate: "2024-03-01", endDate: "2024-03-02", roomTypeID: "RT1", total: 100 };
}

type RoomSpec = { sub: string; roomTypeID?: string; rates?: Record<string, number> };

function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function nightsOf(checkIn: string, checkOut: string): string[] {
  const out: string[] = [];
  for (let d = checkIn; d < checkOut; d = addDays(d, 1)) out.push(d);
  return out;
}

/** A getReservationsWithRateDetails booking, shaped the way the sandbox returned them. */
function rdBooking(opts: {
  id: string;
  status?: string;
  checkIn: string;
  checkOut: string;
  created?: string;
  rooms?: RoomSpec[];
}): Json {
  const nights = nightsOf(opts.checkIn, opts.checkOut);
  const rooms = opts.rooms ?? [
    { sub: opts.id, rates: Object.fromEntries(nights.map((n, i) => [n, 100 + i])) },
  ];
  return {
    propertyID: "prop-1",
    reservationID: opts.id,
    dateCreated: `${opts.created ?? addDays(opts.checkIn, -20)} 09:00:00`,
    dateModified: `${opts.created ?? addDays(opts.checkIn, -20)} 09:00:00`,
    status: opts.status ?? "checked_out",
    reservationCheckIn: opts.checkIn,
    reservationCheckOut: opts.checkOut,
    guestID: "900000001",
    guestName: GUEST,
    guestCountry: "US",
    guestList: { "900000001": { guestName: GUEST, guestEmail: "guest@example.test" } },
    total: 999,
    balance: 0,
    detailedRates: {},
    rooms: rooms.map((room) => ({
      roomTypeID: room.roomTypeID ?? "RT1",
      subReservationID: room.sub,
      guestID: "900000001",
      guestName: GUEST,
      adults: "2",
      children: "0",
      roomCheckIn: opts.checkIn,
      roomCheckOut: opts.checkOut,
      detailedRoomRates: room.rates ?? Object.fromEntries(nights.map((n) => [n, 150])),
    })),
  };
}

type RdQuery = { checkOutFrom: string; checkOutTo?: string; excludeStatuses?: readonly string[] };

/**
 * The server as the sandbox showed it behaves: filters by check-out and
 * excludeStatuses, ignores status and check-in, pages at 100 with a total.
 * `upper` models the one thing nobody verified: whether checkOutTo is inclusive.
 */
function serve(book: Json[], opts: { upper?: "inclusive" | "exclusive"; honourExclude?: boolean } = {}) {
  const upper = opts.upper ?? "inclusive";
  const honourExclude = opts.honourExclude ?? true;
  client.cloudbedsGetReservationsWithRateDetailsPage.mockImplementation(
    async (_creds: unknown, query: RdQuery, pageNumber: number) => {
      const matched = book.filter((b) => {
        const out = String(b.reservationCheckOut);
        if (out < query.checkOutFrom) return false;
        if (query.checkOutTo !== undefined) {
          if (upper === "inclusive" ? out > query.checkOutTo : out >= query.checkOutTo) return false;
        }
        if (honourExclude && query.excludeStatuses?.includes(String(b.status))) return false;
        return true;
      });
      const start = (pageNumber - 1) * 100;
      return {
        reservations: matched.slice(start, start + 100),
        hasMore: start + 100 < matched.length,
        total: matched.length,
      };
    },
  );
}

function refuseRateDetails(status = 400, message = "Cloudbeds getReservationsWithRateDetails failed (400): Method not available") {
  client.cloudbedsGetReservationsWithRateDetailsPage.mockRejectedValue(
    new client.CloudbedsHttpError(message, status, "getReservationsWithRateDetails"),
  );
}

async function adapter() {
  return createCloudbedsOnboardingAdapter(supabase, "hotel-1", {
    accessToken: "cbat_test",
    tokenType: "Bearer",
    propertyId: "prop-1",
  });
}

/**
 * Every page of one window, the way the worker walks it. A window after 0
 * starts, by default, with the handover a rate-details window before it gives.
 */
async function readWindowWithHandover(
  a: Awaited<ReturnType<typeof adapter>>,
  window: { from: string; to: string; newest?: boolean },
  start: AdapterCursor | null = window.newest ? null : { after: "checkout" },
): Promise<{ rows: AdapterReservationRow[]; handover: AdapterCursor | null }> {
  const rows: AdapterReservationRow[] = [];
  let cursor = start;
  for (let guard = 0; guard < 100; guard += 1) {
    const page = await a.fetchReservationListPage(window, cursor);
    rows.push(...page.rows);
    cursor = page.nextCursor;
    if (!cursor) return { rows, handover: page.nextWindowCursor ?? null };
  }
  throw new Error("window never ended");
}

async function readWindow(
  a: Awaited<ReturnType<typeof adapter>>,
  window: { from: string; to: string; newest?: boolean },
  start?: AdapterCursor | null,
): Promise<AdapterReservationRow[]> {
  return (await readWindowWithHandover(a, window, start)).rows;
}

/** Windows 0..count-1 as the worker runs them, each starting from the last one's handover. */
async function readHistory(a: Awaited<ReturnType<typeof adapter>>, count: number): Promise<AdapterReservationRow[][]> {
  const out: AdapterReservationRow[][] = [];
  let start: AdapterCursor | null = null;
  for (let i = 0; i < count; i += 1) {
    const { rows, handover } = await readWindowWithHandover(a, historyWindow(i), start);
    out.push(rows);
    start = handover;
  }
  return out;
}

function historyWindow(index: number) {
  return { ...historicalWindow(ANCHOR, index), newest: index === 0 };
}

const key = (r: { external_reservation_id: string; stay_date: string }) => `${r.external_reservation_id}:${r.stay_date}`;

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  client.pages = {};
  client.cloudbedsGetReservationsPage.mockReset();
  client.cloudbedsGetReservationsPage.mockImplementation(
    async (_creds: unknown, _from: string, _to: string, status: string, pageNumber: number) => {
      const pages = client.pages[status] ?? [];
      return { reservations: pages[pageNumber - 1] ?? [], hasMore: pageNumber < pages.length };
    },
  );
  client.cloudbedsGetReservationsWithRateDetailsPage.mockReset();
  serve([]);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

/* ── Windows ─────────────────────────────────────────────────────────────── */

describe("history windows by check-out date", () => {
  const w0 = historyWindow(0); // 2025-06-26 .. 2026-06-25, newest
  const w1 = historyWindow(1); // 2024-06-26 .. 2025-06-25
  const w2 = historyWindow(2); // 2023-06-27 .. 2024-06-25

  it("asks for the window widened by a day each side, canceled and no-show left out, open-ended for the newest", () => {
    expect(w0).toEqual({ from: "2025-06-26", to: "2026-06-25", newest: true });
    expect(w1).toEqual({ from: "2024-06-26", to: "2025-06-25", newest: false });
    expect(cloudbedsHistoryQuery(w1)).toEqual({
      checkOutFrom: "2024-06-25",
      checkOutTo: "2025-06-26",
      excludeStatuses: ["canceled", "no_show"],
    });
    expect(cloudbedsHistoryQuery({ ...w0, openEnd: true })).toEqual({
      checkOutFrom: "2025-06-25",
      checkOutTo: undefined,
      excludeStatuses: ["canceled", "no_show"],
    });
  });

  /**
   * One book with a booking on every edge. Each must be stored by exactly one
   * owner — a history window, or the live sync for check-ins from the anchor
   * on — with every one of its nights, whether Cloudbeds' upper check-out
   * bound turns out to be inclusive or not.
   */
  const edgeBook = [
    // Inside window 1.
    rdBooking({ id: "E1", checkIn: "2024-09-01", checkOut: "2024-09-04" }),
    // Checks out on window 1's last day.
    rdBooking({ id: "E2", checkIn: "2025-06-23", checkOut: "2025-06-25" }),
    // Checks out on window 0's first day: spans the 1/0 edge.
    rdBooking({ id: "E3", checkIn: "2025-06-24", checkOut: "2025-06-26" }),
    // Checks in inside window 2, out inside window 0: two edges.
    rdBooking({ id: "E4", checkIn: "2024-06-20", checkOut: "2025-07-02" }),
    // Checks out on the anchor: its last night is the day before.
    rdBooking({ id: "E5", checkIn: "2026-06-22", checkOut: ANCHOR }),
    // In house on the anchor: checks in before it, out after.
    rdBooking({ id: "E6", checkIn: "2026-06-24", checkOut: "2026-06-29" }),
    // A long stay from window 2 to well past the anchor.
    rdBooking({ id: "E7", checkIn: "2024-06-01", checkOut: "2026-08-15" }),
    // Checks in on the anchor: the live sync's, not history's.
    rdBooking({ id: "E8", checkIn: ANCHOR, checkOut: "2026-06-28" }),
    // Checks out on window 2's first day, and the day before it.
    rdBooking({ id: "E9", checkIn: "2023-06-25", checkOut: "2023-06-27" }),
    rdBooking({ id: "E10", checkIn: "2023-06-24", checkOut: "2023-06-26" }),
    // Day use on window 1's last day.
    rdBooking({ id: "E11", checkIn: "2025-06-25", checkOut: "2025-06-25", rooms: [{ sub: "E11", rates: { "2025-06-25": 40 } }] }),
  ];

  const expectedOwner: Record<string, string> = {
    E1: "w1", E2: "w1", E3: "w0", E4: "w0", E5: "w0", E6: "w0", E7: "w0", E8: "live", E9: "w2", E10: "older", E11: "w1",
  };

  it.each(["inclusive", "exclusive"] as const)(
    "puts every booking in exactly one window with all its nights (upper bound %s)",
    async (upper) => {
      serve(edgeBook, { upper });
      const a = await adapter();

      const [r0, r1, r2] = await readHistory(a, 3);
      const byWindow: Record<string, AdapterReservationRow[]> = { w0: r0, w1: r1, w2: r2 };

      const ownerOf = new Map<string, string[]>();
      for (const [name, rows] of Object.entries(byWindow)) {
        for (const r of rows) {
          const rid = r.external_reservation_id.replace(/-\d+$/, "");
          const owners = ownerOf.get(rid) ?? [];
          if (!owners.includes(name)) owners.push(name);
          ownerOf.set(rid, owners);
        }
      }
      for (const [rid, owner] of Object.entries(expectedOwner)) {
        if (owner === "live" || owner === "older") {
          expect(ownerOf.get(rid), rid).toBeUndefined();
        } else {
          expect(ownerOf.get(rid), rid).toEqual([owner]);
        }
      }

      // Every night of every booking a window owns, once, nights past the anchor included.
      const all = Object.values(byWindow).flat();
      expect(new Set(all.map(key)).size).toBe(all.length);
      for (const b of edgeBook) {
        const rid = String(b.reservationID);
        if (!["w0", "w1", "w2"].includes(expectedOwner[rid])) continue;
        const want = Object.keys((b.rooms as Json[])[0].detailedRoomRates as Json).sort();
        const got = all.filter((r) => r.external_reservation_id === `${rid}-1`).map((r) => r.stay_date).sort();
        expect(got, rid).toEqual(want);
      }
      expect(all.filter((r) => r.external_reservation_id === "E7-1")).toHaveLength(nightsOf("2024-06-01", "2026-08-15").length);
      expect(all.some((r) => r.external_reservation_id === "E6-1" && r.stay_date === "2026-06-28")).toBe(true);
    },
  );

  it("tiles the live sync's own ownership rule: check-ins from the anchor are never history's", async () => {
    serve(edgeBook);
    const a = await adapter();
    const history = (await readHistory(a, 3)).flat();
    // The live sync stores a booking when its check-in is on or after the anchor.
    const liveIds = new Set(
      edgeBook.filter((b) => String(b.reservationCheckIn) >= ANCHOR).map((b) => `${String(b.reservationID)}-1`),
    );
    expect(history.filter((r) => liveIds.has(r.external_reservation_id))).toEqual([]);
    // And everything that checks in before it and out on or after window 2 starts is history's.
    const historyIds = new Set(history.map((r) => r.external_reservation_id));
    for (const b of edgeBook) {
      const inHistory = String(b.reservationCheckIn) < ANCHOR && String(b.reservationCheckOut) >= w2.from;
      expect(historyIds.has(`${String(b.reservationID)}-1`), String(b.reservationID)).toBe(inHistory);
    }
  });

  it("reads a booking that spans a window edge on one page and stores it once, all nights", async () => {
    serve([rdBooking({ id: "S1", checkIn: "2025-06-20", checkOut: "2025-06-30" })]);
    const a = await adapter();

    const older = await readWindow(a, w1);
    const newer = await readWindow(a, w0);

    expect(older).toEqual([]);
    expect(newer.map((r) => r.stay_date)).toEqual(nightsOf("2025-06-20", "2025-06-30"));
    expect(client.cloudbedsGetReservationsWithRateDetailsPage).toHaveBeenCalledTimes(2);
  });

  it("leaves no gap after windows the list-only deploy imported by check-in", async () => {
    // A job that finished windows 0 and 1 by check-in before this shipped, and
    // starts window 2 with the empty cursor that deploy left.
    const spanning = rdBooking({ id: "T1", checkIn: "2024-06-20", checkOut: "2024-06-30" }); // in w2, out in w1
    const inside = rdBooking({ id: "T2", checkIn: "2024-01-10", checkOut: "2024-01-12" });
    const ownedByOldW1 = rdBooking({ id: "T3", checkIn: "2024-07-01", checkOut: "2024-07-03" });
    serve([spanning, inside, ownedByOldW1]);
    const a = await adapter();

    const rows = await readWindow(a, w2, null);

    const ids = new Set(rows.map((r) => r.external_reservation_id));
    expect([...ids].sort()).toEqual(["T1-1", "T2-1"]);
    expect(rows.filter((r) => r.external_reservation_id === "T1-1")).toHaveLength(10);
  });

  it("leaves no gap after a window the list fallback read by check-in", async () => {
    const spanning = rdBooking({ id: "F1", checkIn: "2024-06-20", checkOut: "2024-06-30" }); // in w2, out in w1
    serve([spanning]);
    // Window 1 refused and read from the list, by check-in: F1 checks in before it.
    refuseRateDetails();
    const a = await adapter();
    const { handover } = await readWindowWithHandover(a, w1);
    expect(handover).toEqual({ after: "checkin" });

    // The next run is allowed rate details again and picks window 2 up from that handover.
    serve([spanning]);
    const b = await adapter();
    const rows = await readWindow(b, w2, handover);
    expect(rows.map((r) => r.stay_date)).toEqual(nightsOf("2024-06-20", "2024-06-30"));
  });
});

/* ── Rows ────────────────────────────────────────────────────────────────── */

describe("history rows from rate details", () => {
  it("gives each room of a mixed multi-room booking its own room type and nightly rates", async () => {
    serve([
      rdBooking({
        id: "6001",
        checkIn: "2025-03-01",
        checkOut: "2025-03-03",
        created: "2025-02-01",
        rooms: [
          { sub: "6001", roomTypeID: "RT1", rates: { "2025-03-01": 300, "2025-03-02": 320 } },
          { sub: "6001-2", roomTypeID: "RT2", rates: { "2025-03-01": 150, "2025-03-02": 150 } },
          { sub: "6001-3", roomTypeID: "RT3", rates: { "2025-03-01": 155, "2025-03-02": 165 } },
        ],
      }),
    ]);
    const a = await adapter();

    const rows = await readWindow(a, historyWindow(1));

    expect(Object.fromEntries(rows.map((r) => [key(r), [r.external_room_type_id, r.current_rate]]))).toEqual({
      "6001-1:2025-03-01": ["RT1", 300],
      "6001-1:2025-03-02": ["RT1", 320],
      "6001-2:2025-03-01": ["RT2", 150],
      "6001-2:2025-03-02": ["RT2", 150],
      "6001-3:2025-03-01": ["RT3", 155],
      "6001-3:2025-03-02": ["RT3", 165],
    });
    expect(rows[0]).toEqual({
      external_reservation_id: "6001-1",
      external_room_type_id: "RT1",
      stay_date: "2025-03-01",
      booking_date: "2025-02-01",
      booking_window_days: 28,
      current_rate: 300,
      raw_payload: null,
    });
    // Neither the old even spread nor the booking sum.
    expect(rows.some((r) => r.current_rate === 999 / 6 || r.current_rate === 605)).toBe(false);
  });

  it("asks the server to leave canceled and no-show out, and drops them itself when it does not", async () => {
    const book = [
      rdBooking({ id: "A1", status: "confirmed", checkIn: "2025-01-10", checkOut: "2025-01-11" }),
      rdBooking({ id: "A2", status: "checked_in", checkIn: "2025-01-10", checkOut: "2025-01-11" }),
      rdBooking({ id: "A3", status: "checked_out", checkIn: "2025-01-10", checkOut: "2025-01-11" }),
      rdBooking({ id: "A4", status: "not_confirmed", checkIn: "2025-01-10", checkOut: "2025-01-11" }),
      rdBooking({ id: "X1", status: "canceled", checkIn: "2025-01-10", checkOut: "2025-01-11" }),
      rdBooking({ id: "X2", status: "no_show", checkIn: "2025-01-10", checkOut: "2025-01-11" }),
      rdBooking({ id: "X3", status: "inquiry", checkIn: "2025-01-10", checkOut: "2025-01-11" }),
    ];
    serve(book, { honourExclude: false });
    const a = await adapter();

    const rows = await readWindow(a, historyWindow(1));

    expect(rows.map((r) => r.external_reservation_id).sort()).toEqual(["A1-1", "A2-1", "A3-1", "A4-1"]);
    const [, query] = client.cloudbedsGetReservationsWithRateDetailsPage.mock.calls[0];
    expect(query).toMatchObject({ excludeStatuses: ["canceled", "no_show"] });
    expect(query).not.toHaveProperty("status");
    expect(client.cloudbedsGetReservationsPage).not.toHaveBeenCalled();
  });

  it("matches what the live sync's detail parser stores for the same bookings, bar raw_payload", async () => {
    const book: Json[] = [];
    let n = 0;
    for (let day = "2024-07-01"; day < "2026-06-24"; day = addDays(day, 3)) {
      n += 1;
      const stayLen = 1 + (n % 4);
      const checkOut = addDays(day, stayLen);
      const nights = nightsOf(day, checkOut);
      const roomCount = 1 + (n % 3);
      book.push(
        rdBooking({
          id: String(80000 + n),
          status: ["confirmed", "checked_in", "checked_out", "not_confirmed", "canceled", "no_show"][n % 6],
          checkIn: day,
          checkOut,
          created: addDays(day, -(n % 50)),
          rooms: Array.from({ length: roomCount }, (_, i) => ({
            sub: i === 0 ? String(80000 + n) : `${80000 + n}-${i + 1}`,
            roomTypeID: `RT${1 + ((n + i) % 3)}`,
            rates: Object.fromEntries(nights.map((d, j) => [d, n % 11 === 0 && j === 0 ? -20 : 90 + i * 10 + j * 5])),
          })),
        }),
      );
    }
    // Statuses left to the client too, so it is paging and filtering that matched.
    serve(book, { honourExclude: false });
    const a = await adapter();

    const history = (await readHistory(a, 2)).flat();

    const live = book
      .map((b) => cloudbedsRateDetailsToDetail(b))
      .filter((d) => ["confirmed", "checked_in", "checked_out", "not_confirmed"].includes(String(d.status)))
      .flatMap((d) => parseCloudbedsReservationDetail(d).rows)
      .map((r) => ({ ...r, raw_payload: null }));

    const sort = (rows: { external_reservation_id: string; stay_date: string }[]) =>
      [...rows].sort((x, y) => key(x).localeCompare(key(y)));
    expect(live.length).toBeGreaterThan(200);
    expect(sort(history)).toEqual(sort(live));
    // More than one page, so paging is part of what matched.
    expect(client.cloudbedsGetReservationsWithRateDetailsPage.mock.calls.length).toBeGreaterThan(2);
  });

  it("keeps guest fields out of every row and every log line, refusal included", async () => {
    const logs = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "info").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
      warn,
    ];
    serve([rdBooking({ id: "G1", checkIn: "2025-02-01", checkOut: "2025-02-04" })]);
    const a = await adapter();
    const rows = await readWindow(a, historyWindow(1));

    expect(rows).toHaveLength(3);
    const text = JSON.stringify(rows);
    for (const needle of [GUEST, "900000001", "guest@example.test", "guestName", "guestID", "guestCountry"]) {
      expect(text).not.toContain(needle);
    }
    expect(rows.every((r) => r.raw_payload === null)).toBe(true);

    // Refused: the fallback logs, and still nothing about a guest.
    refuseRateDetails();
    client.pages = { checked_out: [[{ ...listBooking("G2", "checked_out"), guestName: GUEST, guestEmail: "guest@example.test" }]] };
    const b = await adapter();
    const fallbackRows = await readWindow(b, historyWindow(1));
    expect(fallbackRows.map((r) => r.external_reservation_id)).toEqual(["G2-1"]);
    expect(JSON.stringify(fallbackRows)).not.toContain(GUEST);

    const logged = logs.flatMap((spy) => spy.mock.calls.map((c: unknown[]) => JSON.stringify(c)));
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) {
      expect(line).not.toContain(GUEST);
      expect(line).not.toContain("guest@example.test");
    }
    for (const spy of logs.slice(0, 3)) spy.mockRestore();
  });
});

/* ── Checkpointing ───────────────────────────────────────────────────────── */

describe("history cursor", () => {
  /** 250 bookings checking out inside window 1: three pages. */
  const bigBook = Array.from({ length: 250 }, (_, i) =>
    rdBooking({ id: String(10000 + i), checkIn: addDays("2024-08-01", i), checkOut: addDays("2024-08-03", i) }),
  );

  it("is the page number alone, one call per page", async () => {
    serve(bigBook);
    const a = await adapter();
    const w = historyWindow(1);

    const p1 = await a.fetchReservationListPage(w, { after: "checkout" });
    expect(p1.nextCursor).toEqual({ pageNumber: 2 });
    const p2 = await a.fetchReservationListPage(w, p1.nextCursor);
    expect(p2.nextCursor).toEqual({ pageNumber: 3 });
    const p3 = await a.fetchReservationListPage(w, p2.nextCursor);
    expect(p3.nextCursor).toBeNull();
    expect(p3.nextWindowCursor).toEqual({ after: "checkout" });

    expect(client.cloudbedsGetReservationsWithRateDetailsPage.mock.calls.map((c) => c[2])).toEqual([1, 2, 3]);
    expect(p1.rows.length + p2.rows.length + p3.rows.length).toBe(500);
  });

  it("resumes a killed run on the exact page, in a fresh adapter", async () => {
    serve(bigBook);
    const w = historyWindow(1);
    const first = await adapter();
    const p1 = await first.fetchReservationListPage(w, { after: "checkout" });
    // The invocation dies here; the worker stored p1.nextCursor as JSON.
    const stored = JSON.parse(JSON.stringify(p1.nextCursor)) as AdapterCursor;

    client.cloudbedsGetReservationsWithRateDetailsPage.mockClear();
    const second = await adapter();
    const rest = await readWindow(second, w, stored);

    expect(client.cloudbedsGetReservationsWithRateDetailsPage.mock.calls.map((c) => c[2])).toEqual([2, 3]);
    const all = [...p1.rows, ...rest];
    expect(new Set(all.map(key)).size).toBe(500);
  });

  it("restarts a window at rate-details page 1 from a cursor the list-only deploy saved", async () => {
    serve(bigBook);
    const a = await adapter();

    // Part way through checked_out, page 3, when this shipped.
    const page = await a.fetchReservationListPage(historyWindow(1), { statusIndex: 2, pageNumber: 3 });

    expect(client.cloudbedsGetReservationsWithRateDetailsPage).toHaveBeenCalledTimes(1);
    expect(client.cloudbedsGetReservationsWithRateDetailsPage.mock.calls[0][2]).toBe(1);
    expect(client.cloudbedsGetReservationsPage).not.toHaveBeenCalled();
    expect(page.rows).toHaveLength(200);
    // Open-ended, like any window whose newer neighbour was read by check-in,
    // and the cursor keeps asking that same question on page 2.
    expect(client.cloudbedsGetReservationsWithRateDetailsPage.mock.calls[0][1]).toMatchObject({ checkOutTo: undefined });
    expect(page.nextCursor).toEqual({ pageNumber: 2, openEnd: true });
    await a.fetchReservationListPage(historyWindow(1), page.nextCursor);
    expect(client.cloudbedsGetReservationsWithRateDetailsPage.mock.calls[1][1]).toMatchObject({ checkOutTo: undefined });
    expect(client.cloudbedsGetReservationsWithRateDetailsPage.mock.calls[1][2]).toBe(2);
  });

  it("closes a window only on a handover from a window owned by check-out", async () => {
    serve(bigBook);
    const a = await adapter();
    const w = historyWindow(2);
    const queries = client.cloudbedsGetReservationsWithRateDetailsPage.mock.calls;

    await a.fetchReservationListPage(w, { after: "checkout" });
    await a.fetchReservationListPage(w, { after: "checkin" });
    await a.fetchReservationListPage(w, null);
    await a.fetchReservationListPage(historyWindow(0), { after: "checkout" });

    expect(queries.map((q) => (q[1] as RdQuery).checkOutTo)).toEqual(["2024-06-26", undefined, undefined, undefined]);
  });

  it("treats a garbage cursor as the start of the window", async () => {
    serve(bigBook);
    const a = await adapter();
    await a.fetchReservationListPage(historyWindow(1), { pageNumber: "7" } as AdapterCursor);
    expect(client.cloudbedsGetReservationsWithRateDetailsPage.mock.calls[0][2]).toBe(1);
  });
});

/* ── Fallback ────────────────────────────────────────────────────────────── */

describe("history for a property that refuses rate details", () => {
  it("imports bookings awaiting confirmation alongside confirmed ones", async () => {
    refuseRateDetails();
    client.pages = {
      confirmed: [[listBooking("c1", "confirmed")]],
      not_confirmed: [[listBooking("p1", "not_confirmed")]],
    };
    const a = await adapter();

    const walked: string[] = [];
    const ids: string[] = [];
    let cursor: AdapterCursor | null = null;
    for (let guard = 0; guard < 20; guard += 1) {
      const page = await a.fetchReservationListPage(WINDOW, cursor);
      walked.push(String(client.cloudbedsGetReservationsPage.mock.calls.at(-1)![3]));
      ids.push(...page.rows.map((r) => r.external_reservation_id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }

    expect(walked).toEqual(["confirmed", "checked_in", "checked_out", "not_confirmed"]);
    expect(ids).toEqual(["c1-1", "p1-1"]);
    // Asked once; every later page goes straight to the list.
    expect(client.cloudbedsGetReservationsWithRateDetailsPage).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("getReservationsWithRateDetails refused");
  });

  it("resumes a cursor saved before not_confirmed joined the list on the status it was on", async () => {
    // An import part way through checked_in when this shipped. Inserting the
    // new status anywhere but last would have resumed it on the wrong one.
    refuseRateDetails();
    client.pages = { checked_in: [[], [listBooking("i2", "checked_in")]] };
    const a = await adapter();

    const page = await a.fetchReservationListPage(WINDOW, { statusIndex: 1, pageNumber: 2 });

    const [, , , status, pageNumber] = client.cloudbedsGetReservationsPage.mock.calls.at(-1)!;
    expect([status, pageNumber]).toEqual(["checked_in", 2]);
    expect(page.rows.map((r) => r.external_reservation_id)).toEqual(["i2-1"]);
    expect(page.nextCursor).toEqual({ path: "list", statusIndex: 2, pageNumber: 1 });
  });

  it("does not end a window at checked_out any more", async () => {
    refuseRateDetails();
    const a = await adapter();
    const page = await a.fetchReservationListPage(WINDOW, { statusIndex: 2, pageNumber: 1 });
    expect(page.nextCursor).toEqual({ path: "list", statusIndex: 3, pageNumber: 1 });
  });

  it("carries on down the list from its own cursor without asking for rate details again", async () => {
    client.pages = { checked_out: [[], [], [listBooking("o3", "checked_out")]] };
    const a = await adapter();

    const page = await a.fetchReservationListPage(WINDOW, { path: "list", statusIndex: 2, pageNumber: 3 });

    expect(client.cloudbedsGetReservationsWithRateDetailsPage).not.toHaveBeenCalled();
    expect(page.rows.map((r) => r.external_reservation_id)).toEqual(["o3-1"]);
    expect(page.nextCursor).toEqual({ path: "list", statusIndex: 3, pageNumber: 1 });
  });

  it("starts the next window on the list in the same run, and a new run asks again", async () => {
    refuseRateDetails();
    const a = await adapter();
    await readWindow(a, historyWindow(1));
    await readWindow(a, historyWindow(2));
    expect(client.cloudbedsGetReservationsWithRateDetailsPage).toHaveBeenCalledTimes(1);

    const b = await adapter();
    await b.fetchReservationListPage(historyWindow(3), null);
    expect(client.cloudbedsGetReservationsWithRateDetailsPage).toHaveBeenCalledTimes(2);
  });

  it("filters the list fallback by check-in over the window, as it always did", async () => {
    refuseRateDetails();
    const a = await adapter();
    await a.fetchReservationListPage(WINDOW, null);
    const [, from, to, status, pageNumber] = client.cloudbedsGetReservationsPage.mock.calls[0];
    expect([from, to, status, pageNumber]).toEqual([WINDOW.from, WINDOW.to, "confirmed", 1]);
  });

  it.each([
    [503, "Cloudbeds getReservationsWithRateDetails failed (503): upstream"],
    [429, "Cloudbeds getReservationsWithRateDetails failed (429): slow down"],
    [401, "Cloudbeds getReservationsWithRateDetails failed (401): token revoked"],
  ])("does not fall back on a %i — that is an outage or a revoked grant, not a refusal", async (status, message) => {
    refuseRateDetails(status, message);
    const a = await adapter();

    await expect(a.fetchReservationListPage(historyWindow(1), null)).rejects.toThrow(message);
    expect(client.cloudbedsGetReservationsPage).not.toHaveBeenCalled();
  });
});

describe("parseCloudbedsHistoryRateDetails", () => {
  it("counts what it dropped and why, and owns nothing without a check-in", () => {
    const w = historyWindow(1);
    const { rows, stats } = parseCloudbedsHistoryRateDetails(
      [
        rdBooking({ id: "K1", checkIn: "2025-01-01", checkOut: "2025-01-02" }),
        rdBooking({ id: "K2", status: "canceled", checkIn: "2025-01-01", checkOut: "2025-01-02" }),
        rdBooking({ id: "K3", status: "mystery", checkIn: "2025-01-01", checkOut: "2025-01-02" }),
        rdBooking({ id: "K4", checkIn: "2025-07-01", checkOut: "2025-07-02" }),
        { ...rdBooking({ id: "K5", checkIn: "2025-01-01", checkOut: "2025-01-02" }), reservationCheckIn: null },
      ],
      w,
    );
    expect(rows.map((r) => r.external_reservation_id)).toEqual(["K1-1"]);
    expect(stats).toEqual({ bookings: 5, owned: 1, canceled: 1, unknownStatus: 1, outsideWindow: 2, missingReservationId: 0 });
  });
});
