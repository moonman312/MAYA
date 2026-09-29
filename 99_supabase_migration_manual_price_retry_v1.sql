-- ============================================================================
-- MANUAL PRICE RETRY: one more send when the owner presses Try again
-- ============================================================================
--
-- The price editor tells the owner the truth about a typed price that the
-- property system refused: how many tries MAYA has left at that price, and,
-- once it has stopped retrying (its tries used, or the cause held), that the
-- price could not be sent, with a Try again button. Try again has to make the
-- push send that one cell once more, past the retry decision that is holding
-- it (_shared/pms/push-failure.ts retryDecision).
--
-- rate_updates.retry_requested_at is that request. POST /api/manual-price/retry
-- stamps it with now() on the cell's failed row (service role), then nudges the
-- hotel's sync. The push reads it with the failed row and treats a stamp newer
-- than pushed_at as "rested": one more try, whatever the cause. The try's own
-- ledger write moves pushed_at past the stamp, so a second try needs a second
-- press; the stamp itself is never cleared or rewritten by the push (its
-- upserts do not carry the column, so PostgREST leaves it as it is).
--
-- Idempotent: a second press while the stamp is already newer than pushed_at
-- answers "already requested" and nudges nothing; the route reads the row
-- before it writes.
--
-- RLS and grants are unchanged. The column sits on rate_updates, whose read
-- policy (any member of the hotel, 99_supabase_migration_rls_hardening_v1.sql)
-- and write policies (service role, plus can_manage_hotel) already cover it.
--
-- Run AFTER 99_supabase_migration_rate_push_v1.sql. Idempotent.
--
-- Deploy order: either. Code first: the push's ledger read names a column that
-- is not there yet, is refused once, and reads again without it, so no cell is
-- taken as asked for; the retry route answers with a 503 and the plain
-- "Something on our side isn't ready yet. Email us and tell us which page you
-- were on." This file first: the column is there and nothing writes it until
-- the code lands.
--
-- NOT mirrored into 02_supabase_schema.sql yet — fold it in on the next
-- schema consolidation pass.

begin;

alter table public.rate_updates
  add column if not exists retry_requested_at timestamptz;

comment on column public.rate_updates.retry_requested_at is
  'When Try again was last pressed on this night''s price in MAYA. The push '
  'sends the cell once more when this is newer than pushed_at, then its own '
  'write moves pushed_at past it. Null when never pressed.';

commit;
