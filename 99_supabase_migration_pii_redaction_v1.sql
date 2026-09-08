-- ============================================================================
-- PII redaction backfill (v1)
--
-- COMPLIANCE REQUIREMENT. Maya's privacy policy states we never store guest
-- personal data, but `reservations.raw_payload` historically persisted the
-- full PMS payload (guest names, emails, phones, addresses, notes). As of
-- this migration the app-side ETL redacts every payload before persisting
-- (see maya-rms/supabase/functions/_shared/pms/redact.ts — the allowlist
-- below MUST stay in sync with REDACTION_ALLOWLIST_UNION exported there).
-- This backfill brings all pre-existing rows into compliance.
--
-- Strategy: strict allowlist projection. Keys not listed are dropped.
-- Non-object payloads (arrays/scalars — shouldn't exist) are nulled.
-- Idempotent: rows already carrying the `_redacted` marker are skipped.
-- ============================================================================

update reservations
set raw_payload = coalesce(
      (
        select jsonb_object_agg(e.key, e.value)
        from jsonb_each(raw_payload) as e(key, value)
        where e.key in (
          -- Cloudbeds allowlist
          'status', 'reservationID', 'reservationId', 'subReservationID',
          'reservationRoomID', 'roomID', 'roomTypeID', 'roomTypeId',
          'roomTypeName', 'roomName',
          'startDate', 'endDate', 'dateCreated', 'dateModified',
          'adults', 'children', 'guestCount',
          'sourceName', 'sourceID', 'source', 'channel', 'origin',
          'thirdPartyIdentifier',
          -- Mews allowlist
          'Id', 'State', 'Number', 'ServiceId', 'RateId',
          'RequestedCategoryId', 'AssignedResourceId', 'SpaceCategoryId',
          'ResourceCategoryId', 'RoomCategoryId',
          'CreatedUtc', 'UpdatedUtc', 'StartUtc', 'EndUtc',
          'ScheduledStartUtc', 'ScheduledEndUtc', 'ArrivalDate',
          'DepartureDate', 'CheckInUtc', 'CheckOutUtc',
          'AdultCount', 'ChildCount', 'PersonCount',
          'Origin', 'ChannelNumber', 'ChannelManagerNumber', 'TravelAgencyId'
        )
        -- Scalars only: nested objects/arrays (dailyRates, guest lists, rate
        -- breakdowns) are already parsed into columns or unneeded.
        and jsonb_typeof(e.value) in ('string', 'number', 'boolean')
      ),
      '{}'::jsonb
    ) || '{"_redacted": true}'::jsonb
where raw_payload is not null
  and jsonb_typeof(raw_payload) = 'object'
  and not (raw_payload ? '_redacted');

-- Payloads that are not objects carry no value we use — null them outright.
update reservations
set raw_payload = null
where raw_payload is not null
  and jsonb_typeof(raw_payload) <> 'object';

-- Verification (run manually):
--   select count(*) from reservations
--   where raw_payload ?| array['guestName','guestEmail','guestPhone','guest',
--                              'Customer','CustomerId','notes','cardNumber'];
--   -- must return 0
