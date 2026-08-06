-- Card verification becomes two checks, not one.
--
-- v1 modelled a single verdict: check the card at signup + 48h, stamp it, done.
-- Jake's requirement is both — verify the card immediately AND again 48 hours
-- later — because the two catch different things. The immediate check catches a
-- card that was never good; the 48-hour one catches a virtual card cancelled
-- after signup, which is the whole reason the delay exists.
--
-- One verdict column can't express that: card_verified_at is what takes a row
-- OUT of the sweep, so stamping it at signup would mean the 48-hour check never
-- ran. So the stages get a stamp each, and only the second is terminal:
--
--   card_verified_at   the signup-time check (not terminal — a recheck is owed)
--   card_rechecked_at  the 48-hour check (terminal)
--   card_verify_due_at when the NEXT check is due; null once nothing is owed
--
-- Run AFTER 99_supabase_migration_card_reverify_v1.sql. Idempotent.

alter table hotel_subscriptions
  add column if not exists card_rechecked_at timestamptz;

comment on column hotel_subscriptions.card_verified_at is
  'The signup-time card check. Not terminal: a 48-hour recheck is still owed.';
comment on column hotel_subscriptions.card_rechecked_at is
  'The 48-hour recheck. Terminal — a row with this set is never swept again.';

-- v1's index keyed on card_verified_at being null, which is now the normal state
-- of a row that still owes its recheck. The sweep's predicate is the terminal
-- stamp instead.
drop index if exists idx_hotel_subscriptions_card_due;
create index if not exists idx_hotel_subscriptions_card_due
  on hotel_subscriptions(card_verify_due_at)
  where card_rechecked_at is null and card_verify_failed_at is null;

/* ── The re-subscribe reset has a third stamp to clear ────────────────────── */

create or replace function public.billing_reset_card_verify()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.stripe_subscription_id is distinct from old.stripe_subscription_id then
    -- A different subscription means a different card to vouch for, so both
    -- stages start over.
    new.card_verified_at := null;
    new.card_rechecked_at := null;
    new.card_verify_failed_at := null;
    new.card_verify_last_code := null;
    new.card_verify_attempts := 0;
  else
    -- Same subscription. persistSubscription re-projects the whole row on every
    -- webhook and always includes card_verify_due_at, which would re-arm a check
    -- the sweep had already resolved — including dragging a row back to its
    -- immediate check after the sweep had moved it out to 48 hours.
    --
    -- But the sweep writes that column too, and ITS write has to survive. An
    -- earlier version of this preserved old.card_verify_due_at unconditionally,
    -- which threw away the sweep's own "come back in 48 hours" and left the row
    -- permanently due — so the recheck ran minutes after signup instead of two
    -- days later, which is the entire window a cancelled virtual card lives in.
    --
    -- The two writers are told apart by what else moves: every verdict the sweep
    -- records also touches a stamp, the attempt count, or the decline code, and
    -- the webhook touches none of them.
    if new.card_verified_at      is not distinct from old.card_verified_at
   and new.card_rechecked_at     is not distinct from old.card_rechecked_at
   and new.card_verify_failed_at is not distinct from old.card_verify_failed_at
   and new.card_verify_attempts  is not distinct from old.card_verify_attempts
   and new.card_verify_last_code is not distinct from old.card_verify_last_code then
      new.card_verify_due_at := old.card_verify_due_at;
    end if;
  end if;
  return new;
end;
$$;
