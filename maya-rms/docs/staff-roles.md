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
| `analytics` | `analytics_assert_reader`, so every `analytics_*` function | yes | no | yes |
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
there for every staff role. A stalled signup's `signup_code` is blank for
anyone but a platform admin.

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
- `lib/admin/users.ts`: `setStaffRole(ssr, user, role)` calls
  `platform_set_staff_role` under the admin's own session.
- `lib/admin/business-numbers.ts`: `loadBusinessNumbers` and
  `businessTotals`.

## Analytics

MAYA staff are not customers. An event with no hotel whose person holds a
staff role is recorded as a test one (`product_event_emit`), making someone
staff marks their earlier events with no hotel, and the migration marked
those already recorded. The Accounts created count leaves staff logins out
as it leaves out `+` addresses. Inside a property, the property's own flag
decides, as before. See `analytics.md`.
