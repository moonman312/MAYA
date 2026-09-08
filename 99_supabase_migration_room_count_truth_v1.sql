-- Bill for the rooms they actually run.
--
-- The room count was measured once, at onboarding completion, written to
-- onboarding_states.payment_tier_rooms, and then never read by anything and
-- never measured again. A property that signed up at 20 rooms and grew to 60
-- carried on paying for 20 forever, and nothing anywhere would have said so.
--
-- The measurement is not self-reported: room_types.total_rooms comes from the
-- PMS via the import, so under-declaring at checkout means lying to your own
-- property management system, which nobody does by accident.
--
-- Run any time. Idempotent.

alter table hotel_subscriptions
  add column if not exists measured_rooms integer,
  add column if not exists measured_rooms_at timestamptz,
  add column if not exists room_shortfall_since timestamptz,
  add column if not exists room_corrected_at timestamptz;

comment on column hotel_subscriptions.measured_rooms is
  'Active rooms the PMS reports, refreshed on every scheduled sync. Null means never measured.';
comment on column hotel_subscriptions.measured_rooms_at is
  'When measured_rooms was last refreshed. Stale means the sync has stopped running.';
comment on column hotel_subscriptions.room_shortfall_since is
  'When this property was FIRST seen billing for fewer rooms than it runs. The grace clock. Cleared the moment the shortfall is resolved, so a corrected property starts over.';
comment on column hotel_subscriptions.room_corrected_at is
  'Last time MAYA raised billed_rooms to match the measurement, rather than the owner doing it.';

-- The truing sweep asks one question: who has been short for longer than the
-- grace period? Partial, because a correctly-billed property is the normal case
-- and should not be in the index at all.
create index if not exists idx_hotel_subscriptions_room_shortfall
  on hotel_subscriptions(room_shortfall_since)
  where room_shortfall_since is not null;
