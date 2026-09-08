-- MAYA Trial-With-Discount Codes v1 Migration
-- "7 days free, then 75% off" was two codes and checkout takes one. Trial days
-- become an optional add-on to the discount kinds: the kind still names what
-- the code IS (a percent or dollar discount), trial_days rides along when the
-- deal starts with a free run. The pure trial kind stays for codes that grant
-- nothing else.
--
-- Run AFTER 99_supabase_migration_retire_fixed_price_codes_v1.sql. Idempotent.

begin;

alter table signup_codes drop constraint if exists chk_signup_code_shape;
alter table signup_codes add constraint chk_signup_code_shape check (
  (kind = 'trial'
    and trial_days is not null
    and percent_off is null and fixed_price_cents is null and amount_off_cents is null)
  or (kind = 'percent_off'
    and percent_off is not null
    and fixed_price_cents is null and amount_off_cents is null)
  or (kind = 'amount_off'
    and amount_off_cents is not null
    and percent_off is null and fixed_price_cents is null)
);

commit;
