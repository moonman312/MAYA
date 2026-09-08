-- MAYA Retire Fixed-Price Codes v1 Migration
-- There are no fixed-price hotels: every property pays the standard brackets
-- on its actual room count, and a deal is a percent or dollar discount layered
-- on top — so a room-count change just re-prices at the new count with the
-- discount still applied. The fixed_price kind (a tier-pinned room count)
-- contradicted that and is retired before anything ever used it.
--
-- The enum value and columns stay: dropping an enum value means rebuilding the
-- type and everything referencing it, for no behavioral gain — the constraint
-- below is what stops new rows, and the app grants nothing for the kind.
--
-- Run AFTER 99_supabase_migration_amount_off_codes_v1.sql. Idempotent.

begin;

-- Defensive: none exist today (verified before writing this), but a row that
-- somehow appears must not sit live while granting nothing at checkout.
update signup_codes set is_active = false where kind = 'fixed_price';

-- Re-stated without the fixed_price arm, so the retired kind can no longer be
-- inserted at all.
alter table signup_codes drop constraint if exists chk_signup_code_shape;
alter table signup_codes add constraint chk_signup_code_shape check (
  (kind = 'trial'
    and trial_days is not null
    and percent_off is null and fixed_price_cents is null and amount_off_cents is null)
  or (kind = 'percent_off'
    and percent_off is not null
    and trial_days is null and fixed_price_cents is null and amount_off_cents is null)
  or (kind = 'amount_off'
    and amount_off_cents is not null
    and trial_days is null and percent_off is null and fixed_price_cents is null)
);

commit;
