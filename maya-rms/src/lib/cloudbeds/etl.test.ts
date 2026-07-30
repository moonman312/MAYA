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

/** One 3-night booking of `rooms` rooms, as the list endpoint returns it. */
function groupListItem(rooms: unknown[] | null, total: number) {
  return {
    reservationID: "12345",
    status: "checked_out",
    startDate: "2024-03-01",
    endDate: "2024-03-04",
    dateCreated: "2024-01-01",
    total,
    ...(rooms ? { rooms } : {}),
  };
}

/** The same booking as getReservation returns it: one assigned[] entry per room. */
function groupDetail(subIds: string[], nightlyRate: number) {
  return {
    reservationID: "12345",
    status: "checked_out",
    dateCreated: "2024-01-01",
    assigned: subIds.map((id) => ({
      subReservationID: id,
      roomTypeID: "540123",
      dailyRates: [
        { date: "2024-03-01", rate: nightlyRate },
        { date: "2024-03-02", rate: nightlyRate },
        { date: "2024-03-03", rate: nightlyRate },
      ],
    })),
  };
}

const stayKey = (r: { external_reservation_id: string; stay_date: string }) =>
  `${r.external_reservation_id}:${r.stay_date}`;

describe("cloudbeds etl room-night grain", () => {
  it("explodes a multi-room list item into one row per room per night", () => {
    const { reservations } = parseCloudbedsReservations([
      groupListItem(
        [
          { subReservationID: "12345-1", roomTypeID: "540123" },
          { subReservationID: "12345-2", roomTypeID: "540123" },
          { subReservationID: "12345-3", roomTypeID: "540987" },
        ],
        900,
      ),
    ]);

    expect(reservations).toHaveLength(9);
    expect(new Set(reservations.map((r) => r.current_rate))).toEqual(new Set([100]));
    expect(
      reservations.filter((r) => r.stay_date === "2024-03-01").map((r) => r.external_reservation_id)
        .sort(),
    ).toEqual(["12345-1", "12345-2", "12345-3"]);
    // Each room keeps its own type — not room one's, applied to the whole booking.
    expect(
      reservations.find((r) => r.external_reservation_id === "12345-3")?.external_room_type_id,
    ).toBe("540987");
  });

  it("divides the booking total across rooms as well as nights", () => {
    // 10 rooms × 3 nights, total 3000 → 30 rows at 100, not 3 rows at 1000.
    const { reservations } = parseCloudbedsReservations([
      { ...groupListItem(null, 3000), roomsQuantity: 10 },
    ]);

    expect(reservations).toHaveLength(30);
    expect(new Set(reservations.map((r) => r.current_rate))).toEqual(new Set([100]));
  });

  it("keys slim rows so a later detail import upserts over them", () => {
    // A refresh re-runs the historical windows over check-ins the 5-min detail
    // sync already stored. Both paths must land on the same
    // (external_reservation_id, stay_date) or every night is counted twice.
    const detail = parseCloudbedsReservationDetail(
      groupDetail(["12345-1", "12345-2"], 200),
    ).rows;
    const table = new Map(detail.map((r) => [stayKey(r), r]));
    expect(table.size).toBe(6);

    // This list payload names no rooms, so the slim pass can only account for
    // the first one — what it must not do is add three more rows on top of six.
    for (const row of parseCloudbedsReservations([groupListItem(null, 1200)]).reservations) {
      table.set(stayKey(row), row);
    }
    expect(table.size).toBe(6);
  });

  it("keys a roomID-only list payload where the detail import will key it", () => {
    // A list `rooms[]` entry commonly names only the physical room, while the
    // detail `assigned[]` entry also carries the sub-reservation id. Honouring
    // roomID put the two paths in different namespaces: 4 rows for 2 room-nights,
    // and neither path could ever prune the other's.
    const slim = parseCloudbedsReservations([
      {
        reservationID: "12345",
        status: "confirmed",
        startDate: "2024-03-01",
        endDate: "2024-03-02",
        dateCreated: "2024-01-01",
        total: 400,
        rooms: [{ roomID: "544559" }, { roomID: "544560" }],
      },
    ]).reservations;
    const detail = parseCloudbedsReservationDetail({
      reservationID: "12345",
      status: "confirmed",
      dateCreated: "2024-01-01",
      assigned: [
        {
          subReservationID: "12345-1",
          roomID: "544559",
          roomTypeID: "540123",
          dailyRates: [{ date: "2024-03-01", rate: 200 }],
        },
        {
          subReservationID: "12345-2",
          roomID: "544560",
          roomTypeID: "540123",
          dailyRates: [{ date: "2024-03-01", rate: 200 }],
        },
      ],
    }).rows;

    expect(slim.map(stayKey).sort()).toEqual(detail.map(stayKey).sort());
    expect(new Map([...detail, ...slim].map((r) => [stayKey(r), r])).size).toBe(2);
  });

  it("does not count stay segments as extra rooms", () => {
    // roomStays[] splits ONE room's stay into segments. Counted as rooms, this
    // single-room booking became 4 room-nights at half the true nightly rate —
    // correct data turned wrong.
    const { reservations } = parseCloudbedsReservations([
      {
        reservationID: "999",
        status: "confirmed",
        startDate: "2024-03-01",
        endDate: "2024-03-03",
        dateCreated: "2024-01-01",
        total: 400,
        roomStays: [
          { startDate: "2024-03-01", endDate: "2024-03-02" },
          { startDate: "2024-03-02", endDate: "2024-03-03" },
        ],
      },
    ]);

    expect(reservations.map(stayKey)).toEqual(["999-1:2024-03-01", "999-1:2024-03-02"]);
    expect(new Set(reservations.map((r) => r.current_rate))).toEqual(new Set([200]));
  });

  it("clips an absurd declared room count", () => {
    // 50000 rooms × 3 nights is 150k rows out of one reservation, and the import
    // worker only checks its row cap after the page is written.
    const { reservations } = parseCloudbedsReservations([
      { ...groupListItem(null, 3000), roomsQuantity: "50000" },
    ]);

    expect(reservations).toHaveLength(64 * 3);
  });

  it("skips a room entry it can't read on both paths, not just one", () => {
    const payload = {
      reservationID: "55",
      status: "confirmed",
      startDate: "2024-03-01",
      endDate: "2024-03-02",
      dateCreated: "2024-01-01",
      total: 200,
      assigned: [
        null,
        {
          subReservationID: "55-2",
          roomTypeID: "540123",
          dailyRates: [{ date: "2024-03-01", rate: 200 }],
        },
      ],
    };

    // The slim pass invented a `55-1` row for the null entry that the detail pass
    // skipped, so nothing ever overwrote or pruned it.
    expect(
      parseCloudbedsReservations([payload]).reservations.map((r) => r.external_reservation_id),
    ).toEqual(["55-2"]);
    expect(
      parseCloudbedsReservationDetail(payload).rows.map((r) => r.external_reservation_id),
    ).toEqual(["55-2"]);
  });

  it("gives two detail rooms two keys when only one of them names itself", () => {
    const { rows } = parseCloudbedsReservationDetail({
      reservationID: "77",
      status: "confirmed",
      dateCreated: "2024-01-01",
      assigned: [
        { roomTypeID: "540123", dailyRates: [{ date: "2024-03-01", rate: 200 }] },
        {
          subReservationID: "77-1",
          roomTypeID: "540123",
          dailyRates: [{ date: "2024-03-01", rate: 210 }],
        },
      ],
    });

    // Deriving `77-1` for the anonymous room collided with the room that spells it
    // out, and the pre-upsert dedupe silently dropped one of the two room-nights.
    expect(rows.map((r) => r.external_reservation_id)).toEqual(["77-2", "77-1"]);
  });

  it("keys detail rooms by slot when the payload carries no sub-reservation id", () => {
    const { rows } = parseCloudbedsReservationDetail({
      reservationID: "12345",
      status: "checked_out",
      dateCreated: "2024-01-01",
      assigned: [
        { roomTypeID: "540123", dailyRates: [{ date: "2024-03-01", rate: 200 }] },
        { roomTypeID: "540123", dailyRates: [{ date: "2024-03-01", rate: 210 }] },
      ],
    });

    // Falling back to the bare parent id here collapsed both rooms onto one key.
    expect(rows.map((r) => r.external_reservation_id)).toEqual(["12345-1", "12345-2"]);
  });
});
