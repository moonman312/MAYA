export type CloudbedsResolvedCredentials = {
  accessToken: string;
  tokenType: string;
  /** Cloudbeds data-API base, e.g. https://hotels.cloudbeds.com/api/v1.2 */
  baseUrl: string;
  /** Cloudbeds property id (propertyID query param on every call). */
  propertyId: string;
  /**
   * How a read that Cloudbeds refuses gets a new token (client.ts cloudbedsGet).
   * Set by a caller that can mint one; without it a refusal is thrown as it is.
   */
  refresh?: CloudbedsTokenRefresh;
};

/**
 * One new token per set of credentials. A token is resolved once when a run
 * starts, and can stop working while it runs; a refusal is only taken as the
 * grant being gone when a token minted after it is refused too.
 */
export type CloudbedsTokenRefresh = {
  /**
   * A token other than the one just refused: minted now, or one another
   * process has stored since. Null when there is none to be had.
   */
  mint: (refusedAccessToken: string) => Promise<{ accessToken: string; tokenType?: string | null } | null>;
  /** mint has been asked, whatever it answered. It is asked once. */
  asked?: boolean;
  /** The token in use is one mint handed over after a refusal. */
  fresh?: boolean;
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
