-- MAYA docs questions v1
--
-- The docs moved from get-maya.com into the app (maya-rms.com/docs). Their
-- helper answers in the reader's browser; the only thing it ever sends is
-- what a reader chooses to send: a question the docs did not answer, a
-- "this didn't help" note, or a vote on a page. On the marketing site those
-- rows went to a Google Sheet. Here they come to this table, written by
-- POST /api/docs-ask/feedback on the service role and read on
-- /admin/docs-questions by platform admins.
--
-- Why not product_events: that log promises that nothing a person types ever
-- travels through it (lib/analytics/events.ts only takes flags, counts and
-- fixed words). A reader's question is free text, so it gets its own table
-- with its own limits.
--
-- What a row holds: the scrubbed question (emails, card-length and
-- phone-length digit runs taken out before it is stored), the docs page the
-- reader was on, the passages the helper showed, an optional note, which
-- button sent it, and whether the reader was signed in to MAYA. No user id,
-- no email, no IP address.
--
-- Run AFTER 02_supabase_schema.sql (needs public.is_platform_admin).
-- Idempotent: safe to run twice.

begin;

create table if not exists public.docs_questions (
  id              bigint generated always as identity primary key,
  created_at      timestamptz not null default now(),
  source          text not null,
  question        text not null default '',
  page            text not null default '',
  sections_shown  text not null default '',
  note            text not null default '',
  signed_in       boolean not null default false,
  constraint docs_questions_source check (source in ('unanswered', 'not-helpful', 'page-useful', 'page-not-useful')),
  constraint docs_questions_question_len check (char_length(question) <= 500),
  constraint docs_questions_page_len check (char_length(page) <= 200),
  constraint docs_questions_sections_len check (char_length(sections_shown) <= 1000),
  constraint docs_questions_note_len check (char_length(note) <= 1000),
  constraint docs_questions_page_shape check (page = '' or page like '/%')
);

create index if not exists idx_docs_questions_created
  on public.docs_questions (created_at desc);

comment on table public.docs_questions is
  'What docs readers chose to send: unanswered questions, "didn''t help" notes and page votes. '
  'Written only by POST /api/docs-ask/feedback on the service role; read by platform admins on '
  '/admin/docs-questions. Text is scrubbed of emails and long digit runs before insert. No user id, no IP.';

alter table public.docs_questions enable row level security;

-- Nobody but the service role writes; platform admins read.
revoke all on public.docs_questions from public, anon, authenticated;
grant select on public.docs_questions to authenticated;
grant select, insert on public.docs_questions to service_role;

drop policy if exists docs_questions_platform_read on public.docs_questions;
create policy docs_questions_platform_read
  on public.docs_questions for select
  using (public.is_platform_admin());

commit;
