/**
 * A refund is not a price.
 *
 * Real properties carry refunds and credits as reservations with a negative
 * total. Divided across their nights they become a negative nightly rate, which
 * the reservations_sync_base_rate trigger copies into base_rate, which fails
 * `check (base_rate is null or base_rate >= 0)`. Because the importer upserts in
 * batches, one refund aborted an entire batch — that is what stalled a live
 * history import at zero rows with errorStreak 3.
 */
import { describe, expect, it } from "vitest";
import { parseCloudbedsReservations } from "../../../supabase/functions/_shared/cloudbeds/etl";

function reservation(total: number) {
  return {
    reservationID: "R1",
    status: "checked_out",
    startDate: "2026-10-01",
    endDate: "2026-10-03",
    total,
    balance: total,
    rooms: [{ roomID: "rm1", roomTypeID: "rt1", subReservationID: "R1-1" }],
  };
}

function ratesOf(total: number): Array<number | null> {
  const { reservations } = parseCloudbedsReservations([reservation(total)] as never);
  return reservations.map((r) => r.current_rate as number | null);
}

describe("negative reservation totals never reach the database", () => {
  it("stores a refund as unknown, not as a negative rate", () => {
    // -643.53 is a real value from a live Cloudbeds demo property.
    for (const rate of ratesOf(-643.53)) {
      expect(rate === null || rate >= 0).toBe(true);
    }
  });

  it("handles a small negative — the rounding-artifact kind", () => {
    for (const rate of ratesOf(-0.66)) {
      expect(rate === null || rate >= 0).toBe(true);
    }
  });

  it("KEEPS an explicit zero, which is a real comp or house-use night", () => {
    // Zero and negative must not be conflated: MAYA prices from a genuine 0.
    const rates = ratesOf(0);
    expect(rates.every((r) => r === 0 || r === null)).toBe(true);
    expect(rates.some((r) => r === 0)).toBe(true);
  });

  it("leaves an ordinary positive rate alone", () => {
    const rates = ratesOf(400);
    expect(rates.every((r) => r === null || r > 0)).toBe(true);
  });

  it("never emits a value that would fail the base_rate check constraint", () => {
    for (const total of [-1000, -643.53, -26.28, -0.01, 0, 0.5, 199.99, 5000]) {
      for (const rate of ratesOf(total)) {
        expect(rate === null || rate >= 0).toBe(true);
      }
    }
  });
});
