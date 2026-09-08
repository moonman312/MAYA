-- Assumption challenges: how owners tell the system a date wasn't normal.
--
-- Owners never edit observation outputs directly ("Expected Bookings = 10").
-- They flag a specific date as not a fair comparison and say why — a holiday
-- we don't model, a renovation, a festival. The exact date is excluded from
-- comparisons immediately (blast radius: one date). Anything bigger — annual
-- recurrence, or feeding the season model — needs corroborating reports from
-- multiple distinct YEARS before it generalizes. See
-- supabase/functions/_shared/observations/reinforcement.ts for the model.

create table if not exists assumption_challenges (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels(id) on delete cascade,
  challenged_date date not null,
  reason_key text not null,
  other_text text, -- required when reason_key = 'other' (checked below + in API)
  scope text not null default 'this_date',
  raised_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (scope in ('this_date', 'annual', 'improve_future')),
  check (reason_key <> 'other' or other_text is not null),
  constraint assumption_challenges_other_text_len_check
    check (other_text is null or char_length(other_text) <= 300)
);

-- Safe re-run: adds the length cap when the table predates it.
do $$ begin
  alter table assumption_challenges
    add constraint assumption_challenges_other_text_len_check
    check (other_text is null or char_length(other_text) <= 300);
exception when duplicate_object or duplicate_table then null; end $$;

create index if not exists idx_assumption_challenges
  on assumption_challenges(hotel_id, challenged_date);

-- Repeat submits of the same flag are conflicts, not duplicate evidence —
-- corroboration is counted by distinct years, never by row count.
create unique index if not exists uq_assumption_challenges
  on assumption_challenges(hotel_id, challenged_date, reason_key, scope);

alter table assumption_challenges enable row level security;

-- Reading is for every member; raising and retracting are owner controls
-- (managers up). Policies are split per command because a FOR ALL policy's
-- WITH CHECK never runs on DELETE — a single combined policy would let
-- read-only roles retract corrections and silently change pricing inputs.
-- raised_by is pinned to the caller so attribution can't be forged.
drop policy if exists assumption_challenges_access on assumption_challenges;
drop policy if exists assumption_challenges_read on assumption_challenges;
create policy assumption_challenges_read on assumption_challenges
  for select using (is_hotel_accessible(hotel_id));
drop policy if exists assumption_challenges_insert on assumption_challenges;
create policy assumption_challenges_insert on assumption_challenges
  for insert with check (
    can_manage_hotel(hotel_id)
    and (raised_by is null or raised_by = auth.uid())
  );
drop policy if exists assumption_challenges_update on assumption_challenges;
create policy assumption_challenges_update on assumption_challenges
  for update using (can_manage_hotel(hotel_id))
  with check (can_manage_hotel(hotel_id));
drop policy if exists assumption_challenges_delete on assumption_challenges;
create policy assumption_challenges_delete on assumption_challenges
  for delete using (can_manage_hotel(hotel_id));
