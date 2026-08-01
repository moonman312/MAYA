-- MAYA Amount-Off Codes v1 Migration
-- Adds the fourth code kind: a fixed dollar amount off the monthly charge, for
-- N months or indefinitely — "$50 off every month for your first year" deals
-- that a percentage can't express cleanly. Also stamps codes with their
-- creator's email so the Command Center list can say who made what (every
-- platform admin already sees every code; this makes that legible).
--
-- The early COMMIT is deliberate: a new enum value cannot be referenced in the
-- same transaction that adds it, and the shape constraint below does. Safe to
-- re-run (idempotent guards throughout).

alter type signup_code_kind add value if not exists 'amount_off';
commit;

begin;

alter table signup_codes
  add column if not exists amount_off_cents integer
    check (amount_off_cents is null or amount_off_cents > 0);

alter table signup_codes
  add column if not exists created_by_email text;

-- Backfill what auth still knows; codes made by since-deleted admins stay null.
update signup_codes s
   set created_by_email = u.email
  from auth.users u
 where s.created_by = u.id
   and s.created_by_email is null;

-- Re-stated with the new arm, and every arm now excludes the new field too —
-- the constraint is what stops a half-filled code from granting the wrong
-- thing at checkout.
alter table signup_codes drop constraint if exists chk_signup_code_shape;
alter table signup_codes add constraint chk_signup_code_shape check (
  (kind = 'trial'
    and trial_days is not null
    and percent_off is null and fixed_price_cents is null and amount_off_cents is null)
  or (kind = 'percent_off'
    and percent_off is not null
    and trial_days is null and fixed_price_cents is null and amount_off_cents is null)
  or (kind = 'fixed_price'
    and fixed_price_cents is not null and fixed_price_interval is not null
    and percent_off is null and amount_off_cents is null)
  or (kind = 'amount_off'
    and amount_off_cents is not null
    and trial_days is null and percent_off is null and fixed_price_cents is null)
);

commit;
