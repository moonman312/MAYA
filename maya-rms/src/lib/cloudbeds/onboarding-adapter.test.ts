/**
 * The history import's slim list pull. It walks getReservations one status and
 * one page at a time and persists a cursor between pages, so what matters is
 * which statuses it walks and that a cursor saved by an earlier deploy still
 * means the same thing after the list changes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const client = vi.hoisted(() => ({
  pages: {} as Record<string, Record<string, unknown>[][]>,
  cloudbedsDiscoverPropertyId: vi.fn(),
  cloudbedsGetHotelDetails: vi.fn(),
  cloudbedsListProperties: vi.fn(),
  cloudbedsGetRoomTypes: vi.fn(),
  cloudbedsGetReservationsPage: vi.fn(),
}));

vi.mock("../../../supabase/functions/_shared/cloudbeds/client.ts", () => client);
vi.mock("../../../supabase/functions/_shared/cloudbeds/request-log.ts", () => ({
  installCloudbedsRequestLogging: vi.fn(),
}));
vi.mock("../../../supabase/functions/_shared/pms/oauth-credentials.ts", () => ({
  resolveOAuthCredentials: vi.fn(),
  persistPropertyId: vi.fn(),
}));

import { createCloudbedsOnboardingAdapter } from "../../../supabase/functions/_shared/cloudbeds/onboarding-adapter";
import type { AdapterCursor } from "../../../supabase/functions/_shared/pms/onboarding-adapter";

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

function booking(id: string, status: string) {
  return { reservationID: id, status, startDate: "2024-03-01", endDate: "2024-03-02", roomTypeID: "RT1", total: 100 };
}

async function adapter() {
  return createCloudbedsOnboardingAdapter(supabase, "hotel-1", {
    accessToken: "cbat_test",
    tokenType: "Bearer",
    propertyId: "prop-1",
  });
}

beforeEach(() => {
  client.pages = {};
  client.cloudbedsGetReservationsPage.mockReset();
  client.cloudbedsGetReservationsPage.mockImplementation(
    async (_creds: unknown, _from: string, _to: string, status: string, pageNumber: number) => {
      const pages = client.pages[status] ?? [];
      return { reservations: pages[pageNumber - 1] ?? [], hasMore: pageNumber < pages.length };
    },
  );
});

describe("cloudbeds history import", () => {
  it("imports bookings awaiting confirmation alongside confirmed ones", async () => {
    client.pages = {
      confirmed: [[booking("c1", "confirmed")]],
      not_confirmed: [[booking("p1", "not_confirmed")]],
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
  });

  it("resumes a cursor saved before not_confirmed joined the list on the status it was on", async () => {
    // An import part way through checked_in when this shipped. Inserting the
    // new status anywhere but last would have resumed it on the wrong one.
    client.pages = { checked_in: [[], [booking("i2", "checked_in")]] };
    const a = await adapter();

    const page = await a.fetchReservationListPage(WINDOW, { statusIndex: 1, pageNumber: 2 });

    const [, , , status, pageNumber] = client.cloudbedsGetReservationsPage.mock.calls.at(-1)!;
    expect([status, pageNumber]).toEqual(["checked_in", 2]);
    expect(page.rows.map((r) => r.external_reservation_id)).toEqual(["i2-1"]);
    expect(page.nextCursor).toEqual({ statusIndex: 2, pageNumber: 1 });
  });

  it("does not end a window at checked_out any more", async () => {
    const a = await adapter();
    const page = await a.fetchReservationListPage(WINDOW, { statusIndex: 2, pageNumber: 1 });
    expect(page.nextCursor).toEqual({ statusIndex: 3, pageNumber: 1 });
  });
});
