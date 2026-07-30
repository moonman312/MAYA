import { describe, expect, it } from "vitest";
import {
  parseCloudbedsReservationDetail,
  parseCloudbedsReservations,
} from "../../../supabase/functions/_shared/cloudbeds/etl";

describe("cloudbeds etl booking windows", () => {
  it("parseCloudbedsReservations stamps each night's own booking window", () => {
    const { reservations } = parseCloudbedsReservations([
      {
        reservationID: "r1",
        status: "confirmed",
        startDate: "2026-09-04",
        endDate: "2026-09-06",
        dateCreated: "2026-07-28",
        total: 300,
      },
    ]);
    const byNight = Object.fromEntries(
      reservations.map((r) => [r.stay_date, r.booking_window_days]),
    );
    // Booked 2026-07-28 for a Friday arrival: 38 days out on the Friday,
    // 39 on the Saturday — never the check-in window stamped on both.
    expect(byNight).toEqual({ "2026-09-04": 38, "2026-09-05": 39 });
  });

  it("parseCloudbedsReservations leaves the window null without a created date", () => {
    const { reservations } = parseCloudbedsReservations([
      { reservationID: "r2", startDate: "2026-09-04", endDate: "2026-09-05" },
    ]);
    expect(reservations).toHaveLength(1);
    expect(reservations[0].booking_window_days).toBeNull();
  });

  it("parseCloudbedsReservationDetail keeps per-night windows", () => {
    const { rows } = parseCloudbedsReservationDetail({
      reservationID: "r3",
      status: "confirmed",
      dateCreated: "2026-07-28",
      assigned: [
        {
          subReservationID: "r3-1",
          roomTypeID: "rt1",
          dailyRates: [
            { date: "2026-09-04", rate: 150 },
            { date: "2026-09-05", rate: 150 },
          ],
        },
      ],
    });
    const byNight = Object.fromEntries(rows.map((r) => [r.stay_date, r.booking_window_days]));
    expect(byNight).toEqual({ "2026-09-04": 38, "2026-09-05": 39 });
  });
});
