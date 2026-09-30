# Staff roles

MAYA staff logins hold a role in `app_roles`. Three roles mean something:

| role | who | reads | changes |
|---|---|---|---|
| `platform_admin` | Jake, and whoever he makes one | everything, at any sign-in | a customer's property only in God Mode |
| `developer` | MAYA's developer | Docs Questions, Users, PMS Access, Pilot Health, the Hotels list and each property's page with its team | nothing |
| `sales` | Sales and BI, one login each | Analytics (money included), Stalled Signups, Pilot Health, Docs Questions, the Hotels list, and a real property's occupancy, ADR and revenue | nothing |

`developer` and `sales` came with `99_supabase_migration_staff_roles_v1.sql`
(2026-09-30). `platform_support` is in the enum and unused.

## What each role reads

The database decides. `staff_can_read(section)` is the check inside every
policy and function a staff page reads through, and `staff_role_sections(role)`
is the map. `lib/admin/staff-sections.ts` holds the same map for building
pages, and a test keeps the two in step.

| section | reads through | platform admin | developer | sales |
|---|---|---|---|---|
| `home` | (the Command Center's first page) | yes | yes | yes |
| `hotels` | `platform_list_hotels` | yes | yes | yes |
| `hotel_team` | `platform_list_hotel_users` | yes | yes | no |
| `users` | `platform_list_users`, `platform_count_users` | yes | yes | no |
| `pms_access` | `pms_signup_gates` (read) | yes | yes | no |
| `pilot_health` | `platform_pilot_health`, the `alert.channel` and `alert.channel_test` lines of `platform_audit_events` | yes | yes | yes |
| `docs_questions` | `docs_questions`, `docs_ask_tally` | yes | yes | yes |
| `analytics` | `analytics_assert_reader`, so every `analytics_*` function (test properties and signup codes: `analytics_full_reader`, admin only) | yes | no | yes |
| `stalled_signups` | `platform_list_stalled_signups` | yes | no | yes |
| `business_numbers` | the MRR columns of `platform_list_hotels`, `staff_hotel_business_numbers` | yes | no | yes |
| `pending_invites`, `signup_codes`, `hotel_create` | (admin only) | yes | no | no |

Everything else that checks `is_platform_admin()` admits platform admins
only, exactly as before: pending invites, signup codes and their redemptions,
support sessions and changes, `product_events`, the rest of the audit log,
creating a hotel, and every function that changes something.

Money on the hotel list (`list_mrr_cents`, `net_mrr_cents`, `mrr_day`, the
newest `hotel_metrics_daily` row) is null unless the caller may read
`business_numbers`, and for anyone but a platform admin it is also null on a
test property. Billing status in words (`billing_status`, `plan_kind`,
`billing_interval`, `billed_rooms`, `trial_end`, `cancel_at_period_end`) is
there for every staff role.

Signup codes stay a platform admin's: a code lets its holder past the
waitlist. A stalled signup's `signup_code` is blank for anyone but a platform
admin. `analytics_acquisition` and `analytics_event_counts` (the
`signup_code.redeemed` detail) say `code` where a signup used one, never
which, to anyone but a caller that reads the way a platform admin does:
`analytics_full_reader()`, which is the service role, a platform admin, or a
direct database session (the SQL editor).

Test properties in analytics are a platform admin's too. Every `analytics_*`
function that takes `p_include_test` counts test properties only for
`analytics_full_reader()`, so a Sales login that asks for them, from the page
or through PostgREST, gets customers only.

`staff_hotel_business_numbers(hotel, from, to)` gives one row per night, up
to 401 nights: rooms sold, sellable rooms (the active types that count as
rooms, less rooms out of service), sellable occupancy, room revenue (every
active type) and ADR (the types that count as rooms), added up the way the
property's calendar does. Totals only, nothing about a booking or a guest.
Sales gets it for real properties only; a test property is refused.

## The code step

A `developer` or `sales` login reads nothing until its token is `aal2`: a
code from an authenticator app, the same TOTP God Mode uses (turn it on in
Supabase, see `docs/command-center-deployment.md`, 3.5). Before the code,
`staff_can_read` is false for them, the functions refuse, and the policies
show no rows. Platform admins read at any sign-in, as before.

`staff_access()` answers the app in one call:

```json
{ "role": "developer", "aal": "aal1", "mfa_required": true, "sections": [] }
```

`role` is the strongest staff role held (`platform_admin`, then `developer`,
then `sales`), or null. `mfa_required` is true for a developer or sales login
whose token is not `aal2` yet.

In the app, that login is sent to `/admin-code` before any Command Center
page. The page is outside `/admin`, so the admin layout never sends it to
itself. The first visit enrols an authenticator app: a QR code and a key,
then a 6-digit code (the factor is named "MAYA Command Center"; it is the
same setup the God Mode button uses, `components/admin/totp-code.tsx`). After
that, each sign-in asks only for a code. A verified code makes the session
`aal2`, which Supabase keeps when it refreshes the session, and the page goes
on to `/admin`. A wrong code says so and stays put. The page also has Sign
out. A platform admin never sees it; anyone past the code, or a platform
admin, who opens it is sent to `/admin`, and someone with no staff role to
`/`.

On the app's first page (`/`), a platform admin or sales login with no
property of its own goes to `/admin` (so a sales login meets the code step)
instead of onboarding. A developer with no property goes to onboarding like
anyone else, since his own test property comes through the ordinary signup;
he reaches the Command Center at `/admin`. Every staff login on a property it
belongs to gets the **Command Center** link on the dashboard.

MAYA staff are the provider, not customers, so the Terms of Service screen
(`/api/legal/acceptance`) never asks a platform admin, developer or sales
login to accept the customer Terms, whatever page they open. Checkout still
asks anyone but a platform admin who buys a property.

## What staff can never do

- **God Mode.** `god_mode_start()` and `god_mode_active()` still require the
  `platform_admin` role itself. A developer or sales login is refused even
  with a fresh code, and even with a window in its name.
- **Change a property.** No write policy and no function that changes
  something admits them. They are not in `is_hotel_accessible` or
  `can_manage_hotel`, so a customer's rules, prices, settings, team, PMS
  connection and billing are out of reach by any route: the app, an API
  route, a function, or PostgREST with their own token.
- **Read guest data.** Reservations and every other hotel table are read
  through `is_hotel_accessible`, which staff roles are not in.
- **Make anyone staff.** Only a platform admin in God Mode can.

A developer or sales login that is a member of a property (the developer's
own test property, say) uses it like any member, through that membership.

## Setting someone's role

`platform_set_staff_role(user, role)` with `none`, `developer`, `sales` or
`platform_admin` leaves the person with exactly that one staff role. It
needs a platform admin in God Mode, or the service role. Every change is an
`app_role.granted` or `app_role.revoked` line in `platform_audit_events`, with
`via: staff_role`. It refuses to remove the last platform admin, and so does
`platform_revoke_role`, whoever asks.

From the SQL editor:

```sql
begin;
select set_config('request.jwt.claim.role', 'service_role', true);
select public.platform_set_staff_role(
  (select id from auth.users where email = 'developer@modern-hospitality-solutions.com'), 'developer');
commit;
```

`platform_grant_role` and `platform_revoke_role` still work one role at a
time, with God Mode.

From the app: Command Center > Users has a **Staff role** column. For a
platform admin it is a picker (None, Developer, Sales, Platform admin); for
a developer it is the role in words. Changing it sends
`PUT /api/admin/users/[userId]/staff-role` with `{ "role": ... }`, which needs
a platform admin (`requirePlatformAdmin`) in God Mode (`requireGodMode`) and
calls `platform_set_staff_role` under the admin's own session, so the database
checks God Mode again and names the admin on the audit line. A refusal (God
Mode off, or "MAYA needs at least one platform admin. Make someone else a
platform admin first.") shows beside the picker and the picker goes back.
`PUT` and `DELETE /api/admin/users/[userId]/platform-admin` still grant and
revoke `platform_admin` alone, with God Mode.

## What each role sees in the Command Center

The nav lists only the role's pages. A page outside the role's sections,
opened by its address, goes back to `/admin`.

| page | platform admin | developer | sales |
|---|---|---|---|
| Overview `/admin` | every tile, **+ New hotel**, the test alert | Hotels, PMS connected, Users and Stale syncs tiles, the docs tally, recent hotels | Hotels, PMS connected and Stale syncs tiles, the docs tally, recent hotels |
| Hotels `/admin/hotels` | PMS, mode, plan, rooms, billing status, MRR; **+ New hotel** | the same without MRR | the same with MRR (empty on a test property) |
| a property `/admin/hotels/[id]` | every control: Open this property, God Mode, Live switch, test flag, PMS card, team with invites | read only: the facts, plan and billing status in words, mode, test flag, PMS status and last sync, the team | read only: the facts, plan and billing status, mode, test flag, PMS status; business numbers on a real property; no team |
| Analytics | with the test toggle, Refresh, and which signup code each subscription used | hidden | customers only: no test toggle, no Refresh; a signup that used a code says "code" |
| Pilot health | yes | yes | yes |
| Users | the Staff role picker | the role in words | hidden |
| PMS Access | the switches | each gate in words ("Code needed", "Open to anyone") | hidden |
| Stalled Signups | with Given up on it, and the code each signup used | hidden | with Email them only, and no code |
| Docs Questions | yes | yes | yes |
| Pending Invites, Signup Codes, New hotel | yes | hidden | hidden |

No page shows a developer a money figure. Billing status in words (Trial,
Active, Past due, ...) shows for every role.

**Business numbers** (a property's page, for a platform admin and for sales
on a real property): occupancy, ADR, room revenue and rooms sold for Last 30
nights (the default), Next 30 nights, Next 90 nights or Last 12 months, in the
hotel's own days and currency, then a line per month when the window spans
more than one. Read with `staff_hotel_business_numbers` under the viewer's own
session. On a test property sales sees "Business numbers are shown for real
properties only."

## How the app holds to it

- **The layout** (`app/admin/layout.tsx`) reads `getStaffSession()` and sends
  anyone not staff past the code away: signed out to
  `/login?next=/admin`, a developer or sales login before its code to
  `/admin-code`, no staff role to `/`. It hands the nav the role and its
  sections, and renders the God Mode banner for a platform admin only.
- **Every page** starts with `requireStaffPage(section)`
  (`lib/admin/staff-page.ts`): a layout is not re-run on every navigation and
  cannot see which page it wraps, so each page checks its own section on the
  server. A page never asks the database for what the role may not read (a
  function a role may not call refuses, it does not answer empty).
- **A developer or sales login gets no control.** A property's page renders
  the read-only cards (`components/admin/hotel-read-only.tsx`, server
  components) in place of the admin's switches and forms; Users, PMS Access
  and Stalled Signups likewise show words or a mail link only.
- **Every `/api/admin` route** that changes something, or reads with the
  service role, keeps `requirePlatformAdmin`, and God Mode where it had it,
  so a developer or sales login gets 403 whether or not it has entered its
  code. The analytics page's Refresh (a Server Action) checks for a platform
  admin too.
- **Analytics** is read with the service role (kept per five minutes, the
  same for every reader), so `requireStaffPage("analytics")` is what stands
  in front of it. For a Sales login the page turns the test toggle off
  whatever the address asks, and the product panels take the signup codes
  out as they are drawn (`withoutSignupCodes` in
  `lib/admin/product-analytics.ts`: "code" in Subscriptions by source, rows
  that then match added up). The database does the same for a Sales login
  calling the functions itself (`analytics_full_reader`).
- **Today's snapshot row.** The first load of a five-minute slot whose
  sections read today's `hotel_metrics_daily` row writes that row first,
  with the service role (`todaySnapshotFor` in `lib/admin/analytics-cache.ts`),
  whoever is looking, a Sales login included. It is derived data, the same
  row the nightly cron writes, and nothing the viewer chooses goes into it.
- **PMS Access** reads `pms_signup_gates` under a developer's own session
  (the service role for a platform admin, whose switches need it).

**What changed for a platform admin.** Beside the role picker and the code
step (which a platform admin never meets), the admin's own Command Center
gained:

- Hotels list: Mode, Plan, Rooms, Billing and MRR columns, the PMS name
  beside its status and a "test" tag; the time zone and currency moved under
  the name (they were a column of their own). The table scrolls sideways
  when it is wider than the window.
- A property's page: Plan, Billing (with the trial's end date) and Rooms in
  the facts, and the Business numbers panel above the controls, read with
  `staff_hotel_business_numbers` on each visit.
- The nav: a Sign out button.

Tests: `app/admin/staff-pages.test.tsx` (every page and the layout per role,
found by listing the folder), `app/api/admin/staff-refused.test.ts` (every
`/api/admin` route as a developer at aal1 and aal2),
`app/admin/staff-views.test.tsx`, `app/admin/hotels/[hotelId]/page.test.tsx`,
`app/admin-code/page.test.tsx`, `app/page-staff.test.tsx`,
`app/admin/analytics/sections.test.tsx` and `lib/admin/product-analytics.test.ts`
(no signup code for Sales), `app/api/legal/acceptance/route.test.ts` (no Terms
screen for staff), and the components' own. The database side is
`lib/admin/staff-roles-migration-sql.test.ts`.

## In the app

- `lib/admin/staff-sections.ts`: the roles, the sections, the map, which
  section each `/admin` path belongs to (`sectionForAdminPath`), and a login's
  role from its app roles (`staffRoleOf`). Safe in client components.
- `lib/admin/staff-session.ts`: `getStaffSession()` for pages, once per
  request (`ok` with the sections, `mfa_required`, `not_staff` or
  `signed_out`); `staffCanSee(session, section)`; and
  `requireStaffSection(cookies, section)` for a route that only reads, which
  answers 401, or 403 with `mfa_required: true` before the code. It hands back
  the caller's own session client, never the service role: a route that
  writes keeps `requirePlatformAdmin`, and God Mode where it has it.
- `lib/admin/staff-page.ts`: `requireStaffPage(section)`, the first line of
  every Command Center page, and `staffSessionRedirect(session)`.
  `STAFF_CODE_PATH` (`/admin-code`) is in `staff-sections.ts`.
- `lib/admin/staff-session.ts` also has `loadStaffRole(ssr, user)`
  (`staff_role()`, falling back to `is_platform_admin` before the migration)
  for the app's first page and the Terms screen's check.
- `lib/admin/users.ts`: `setStaffRole(ssr, user, role)` calls
  `platform_set_staff_role` under the admin's own session.
- `lib/admin/business-numbers.ts`: `loadBusinessNumbers`, `businessTotals`
  and `businessByMonth`; `lib/admin/business-window.ts`: the four windows.
- `lib/admin/hotel-words.ts`: plan, billing status, rooms and mode in words.
- Components: `admin-top-nav.tsx` (`navLinksFor(sections)`),
  `staff-code-step.tsx` and `totp-code.tsx` (the code step, shared with
  `god-mode-button.tsx`), `staff-role-picker.tsx`, `hotel-read-only.tsx`,
  `hotel-business-numbers.tsx`.

## Analytics

MAYA staff are not customers. An event with no hotel whose person holds a
staff role is recorded as a test one (`product_event_emit`), making someone
staff marks their earlier events with no hotel, and the migration marked
those already recorded. The Accounts created count leaves staff logins out
as it leaves out `+` addresses. Inside a property, the property's own flag
decides, as before. See `analytics.md`.
