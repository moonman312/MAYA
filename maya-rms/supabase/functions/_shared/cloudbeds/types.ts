export type CloudbedsResolvedCredentials = {
  accessToken: string;
  tokenType: string;
  /** Cloudbeds data-API base, e.g. https://hotels.cloudbeds.com/api/v1.2 */
  baseUrl: string;
  /** Cloudbeds property id (propertyID query param on every call). */
  propertyId: string;
};

/** Row shapes match the shared `room_types` / `reservations` tables (same as Mews). */
export type CloudbedsParsedRoomType = {
  external_room_type_id: string;
  name: string;
  display_name: string | null;
  total_rooms: number;
};

export type CloudbedsParsedReservationRow = {
  external_reservation_id: string;
  external_room_type_id: string | null;
  stay_date: string;
  booking_date: string | null;
  booking_window_days: number | null;
  current_rate: number | null;
  raw_payload: Record<string, unknown>;
};

export type CloudbedsParseStats = {
  skippedMissingReservationId: number;
  skippedNoStayNights: number;
  duplicateStayNightKeysMerged: number;
  rowsWithMissingRate: number;
  skippedCanceled: number;
};
