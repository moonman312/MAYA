-- Enforce max_redemptions where it can actually be enforced.
--
-- checkCode counts redemptions before Checkout opens, and the row is only
-- written when the webhook lands minutes later. Everything that happens in
-- between sees the old count — so a code capped at one, posted somewhere it
-- shouldn't have been, is redeemed by however many people reach checkout inside
-- that window. The cap reads as a limit and behaves as a suggestion.
--
-- The application check stays: it is what produces a civil "that code has
-- already been used the maximum number of times" instead of a failed webhook.
-- This is the backstop underneath it, and unlike the application check it cannot
-- be raced, because the lock serialises every concurrent insert for one code.
--
-- Run any time. Idempotent.

create or replace function public.enforce_signup_code_cap()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  cap integer;
  used integer;
begin
  -- FOR UPDATE is the whole point. Two inserts for the same code queue here
  -- rather than both reading a stale count and both being allowed through.
  select max_redemptions into cap
    from signup_codes
   where id = new.code_id
     for update;

  if cap is null then
    return new;
  end if;

  select count(*) into used
    from signup_code_redemptions
   where code_id = new.code_id;

  if used >= cap then
    raise exception 'signup code % is fully redeemed (% of %)', new.code_id, used, cap
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_signup_code_cap on signup_code_redemptions;
create trigger trg_signup_code_cap
  before insert on signup_code_redemptions
  for each row
  execute function public.enforce_signup_code_cap();

comment on function public.enforce_signup_code_cap() is
  'Atomic backstop for signup_codes.max_redemptions. The application check runs earlier and gives a better message, but cannot be made race-free from outside the database.';
