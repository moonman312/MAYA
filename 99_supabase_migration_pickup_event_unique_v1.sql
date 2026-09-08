-- Two overlapping evaluation runs (a 5-minute cron tick still mid-flight
-- when a manual POST /api/evaluate lands, or a run that outlives its own
-- tick) both read the same stale baseline before either has inserted a
-- pickup event for it — the read-then-insert window spans the whole
-- candidate-collection phase of a run, not a few milliseconds. Without a
-- DB-level guard both runs insert an active event for the same (rule, stay
-- date, room type), and loadActivePickupEffects applies both, permanently
-- compounding the price adjustment (e.g. -5% becomes -9.75%) until the stay
-- date passes or the rule is edited. Only one non-retired event per (rule,
-- stay date, room type) should ever exist at a time.

create unique index if not exists uq_pickup_event_active_per_rule_stay_room
  on pickup_event (rule_id, stay_date, affected_room_type_id)
  where retired_at is null;
