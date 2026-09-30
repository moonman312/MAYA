# Command Center — Deployment & Secrets

The Command Center (`/admin/*` + `/auth/accept-invite` + `/api/admin/*`) needs three pieces of configuration that are new to this feature. Do these once per environment.

---

## 1. Database — apply the two migrations (in order)

If you already applied `99_supabase_migration_command_center_v1.sql`, only run **v2**. If not, run both in order.

In Supabase Dashboard → SQL Editor:

```
99_supabase_migration_command_center_v1.sql   (already applied)
99_supabase_migration_command_center_v2.sql   ← run this next
```

`v2` adds the `platform_*` RPCs and the `platform_users_view` that the /admin pages call. It's idempotent — safe to re-run.

Verify:

```sql
select proname from pg_proc where proname like 'platform\_%' order by proname;
```

You should see: `platform_grant_role`, `platform_invite_user`, `platform_list_hotel_users`, `platform_list_hotels`, `platform_list_pending_invites`, `platform_list_users`, `platform_log_event`, `platform_remove_membership`, `platform_revoke_pending`, `platform_revoke_role`, `platform_set_membership_role`.

---

## 2. Environment variables (Next.js app)

### `SUPABASE_SERVICE_ROLE_KEY` (required)

Server-only key that bypasses RLS. **Never expose to the browser.**

- **Where to get it:** Supabase Dashboard → Project Settings → API → Service role secret.
- **Local dev:** `.env.local` (this file is git-ignored).
  ```
  SUPABASE_SERVICE_ROLE_KEY=<paste the service role JWT>
  ```
- **Vercel:** Project Settings → Environment Variables. Scope to **Production** and **Preview** only (do not add to Development if you want /admin to fail closed on preview deployments without the key).

Guardrails already in the code:
- `src/utils/supabase/admin.ts` starts with `import "server-only"` — importing it from a client component causes a build error.
- `requirePlatformAdmin` returns HTTP 503 if the key is missing, so /admin renders a helpful banner instead of leaking the misconfiguration.

### `MAYA_INVITE_REDIRECT_BASE` (required if inviting users)

Base URL used in the invite magic-link redirect. Must match the deployed host and must be allowlisted in Supabase (step 3 below).

- **Local dev:** `MAYA_INVITE_REDIRECT_BASE=http://localhost:3000`
- **Vercel prod:** `MAYA_INVITE_REDIRECT_BASE=https://<your-domain>`

Set in `.env.local` and Vercel Environment Variables. Do NOT include a trailing slash.

### Existing vars — no changes

`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY`, `MAYA_DEFAULT_HOTEL_ID` — unchanged.

---

## 3. Supabase Dashboard — Auth configuration

### 3.1 Allowlist the invite-accept and password-reset URLs

Dashboard → Authentication → URL Configuration → **Additional Redirect URLs**. Add:

- `http://localhost:3000/auth/accept-invite`
- `https://<your-prod-domain>/auth/accept-invite`
- `http://localhost:3000/auth/reset-password`
- `https://<your-prod-domain>/auth/reset-password`
- `http://localhost:3000/login*`
- `https://<your-prod-domain>/login*`

The `/login*` entries are for the sign-up confirmation link, which comes back to `/login?confirmed=1` (see 3.6).

If one of these isn't allowlisted, Supabase silently strips the redirect and sends the link to the Site URL instead:

- **Invite links** land on the default post-auth page. The pending-membership trigger still fires so they'll have access, but the "set your password" UX is skipped.
- **Password-reset links** land on the Site URL with a `?code=` nothing redeems. A signed-out visitor is sent on to `/login`, so the person never reaches the "Set a new password" page.

### 3.2 Confirm the invite email template

Dashboard → Authentication → Email Templates → **Invite user**.

Default template is fine. If you want a small tweak, the placeholders `{{ .ConfirmationURL }}` and `{{ .Email }}` are the ones you'll use. The link routes to whatever you allowlisted in 3.1.

### 3.3 Set the Reset Password email template

Dashboard → Authentication → Email Templates → **Reset Password**.

"Forgot password?" on `/login` calls `resetPasswordForEmail` with `redirectTo` set to `<origin>/auth/reset-password`, and Supabase Auth sends this template (through the custom SMTP, which is Resend). `/auth/reset-password` redeems either kind of link:

- **Default template** (`{{ .ConfirmationURL }}`). Works, but the link goes through Supabase's verify page and arrives with a PKCE `?code=`. Only the browser that asked for the reset holds the other half of that code, so the link fails when opened anywhere else (asked on a laptop, opened on a phone).
- **Recommended: link to the page with the token hash.** This works in any browser:

  ```html
  <a href="{{ .SiteURL }}/auth/reset-password?token_hash={{ .TokenHash }}&type=recovery">Set a new password</a>
  ```

  `{{ .SiteURL }}` is the project's Site URL (Authentication → URL Configuration), so it has to be this app's host in each environment.

How long a reset link lasts is Supabase's setting: Authentication → Providers → Email → *Email OTP expiration*.

### 3.4 (Optional) Disable public sign-ups

Once the Command Center is live and you're only onboarding via invites, Dashboard → Authentication → Providers → Email → **Enable sign-ups: off**. Existing self-signup on `/login` "Create Account" button will fail; the invite flow is unaffected.

### 3.5 Enable TOTP MFA (required for God Mode and staff roles)

Dashboard → Authentication → Multi-Factor Authentication → **TOTP: on** (enrol and verify both enabled). Nothing else changes for customers: MFA is never asked of them.

The Developer and Sales staff roles (`99_supabase_migration_staff_roles_v1.sql`) read nothing in the Command Center's database functions and tables until their token is `aal2`, so with TOTP off they can never read anything there. The app sends a developer or sales login to the code step, `/admin-code`, before any Command Center page: the first visit enrols an authenticator with a QR code (the same setup the God Mode button uses), and every later sign-in asks for a code. What each role sees, and how to set one, is in `maya-rms/docs/staff-roles.md`.

God Mode (`99_supabase_migration_god_mode_v1.sql`) is how a platform admin changes a customer's property. A platform admin can open and view any property, but every write to a hotel-owned table (rules, prices, room types, team, settings, the PMS connection, going live) is refused by row level security unless the admin's token is `aal2` and they hold an open window in `support_sessions`. The **GOD MODE** button in the Command Center nav (and on each hotel page), shown to platform admins only, asks for a code from an authenticator app; the first press enrols one with a QR code. A window lasts `god_mode_minutes()` (30) and ends by itself, or from the red banner's **End God Mode**. Entering, leaving and expiring are logged in `platform_audit_events` (`god_mode.started` / `ended` / `expired`); every change made in a window is in `support_changes` and shows in the property's change log as "Changed by MAYA support". With TOTP off in the dashboard, the button reports that authenticator codes are not switched on and God Mode cannot start.

### 3.6 Turn on "Confirm email"

Dashboard → Authentication → Providers → Email → **Confirm email: on**. Run `99_supabase_migration_confirmed_signups_v1.sql` first, so `account.created` counts an account when its address is confirmed rather than when it is typed in.

`/login` passes `emailRedirectTo` = `<origin>/login?confirmed=1` on sign-up and on "Send the link again", so allowlist it (3.1). The default **Confirm signup** template (`{{ .ConfirmationURL }}`) is what the page expects: Supabase confirms the address on its verify page, then sends the browser back with a PKCE `?code=`, which `/login` redeems and then carries on (a waiting Cloudbeds Marketplace claim included). Opened in a browser that didn't sign up, the code can't be redeemed, and the page says the email is confirmed and asks them to sign in. An expired or used link comes back with `error_code`, and the page says so.

Resends are limited per address by Supabase (the button rests for 60 seconds after each send), and all auth emails share the project's email rate limit (Authentication → Rate Limits).

---

## 4. Bootstrap yourself as platform admin

Only needed once per environment. Run in SQL Editor:

```sql
-- Look up your user id
select id, email from auth.users where email = 'scdeloach16@gmail.com';

-- Grant the role
insert into public.app_roles (user_id, role)
values ('<paste-uuid>', 'platform_admin')
on conflict do nothing;

-- Verify (should return true)
select public.is_platform_admin('<paste-uuid>');
```

Sign into the app and navigate to `/admin`. If the RLS bypass and env vars are wired correctly you'll see the Command Center dashboard.

To make someone a Developer or Sales login, or another platform admin, turn on God Mode and set their **Staff role** on Command Center > Users (None, Developer, Sales or Platform admin), or call `platform_set_staff_role` from the SQL editor (see `maya-rms/docs/staff-roles.md`). Either way it needs God Mode (or the service role), logs every change, and never removes the last platform admin.

---

## 5. Testing checklist for a full onboarding

Run through this once end-to-end on staging (or your dev DB with a real email you can receive at):

- [ ] `/admin` loads without a redirect. Overview shows counts.
- [ ] `/admin/hotels/new` → fill Basics + Settings → PMS with valid Mews demo tokens → "Test connection" reports enterprise info → enter your own email as invite recipient → Submit.
- [ ] Redirect lands on `/admin/hotels/[hotelId]`. Overview + PMS card + Members card all populated.
- [ ] Check your inbox for the Supabase invite email. Click the link (or copy into an incognito window).
- [ ] Land on `/auth/accept-invite`. Set a password. Redirect to `/`.
- [ ] Log out, log back in as the invited user. You see only the new hotel; property-select is scoped.
- [ ] Log out. On `/login`, click "Forgot password?" and enter the invited user's email. The reset email arrives. Open its link (in a different browser too, if the template uses the token hash from 3.3), land on `/auth/reset-password`, set a new password, and get redirected to `/`.
- [ ] From an incognito platform-admin session, `/admin/hotels/[hotelId]` shows the accepted user in Members with role `hotel_admin`, and the pending invite row is gone (or marked `accepted` on the Pending Invites page).
- [ ] `/admin/users` shows the new user. With God Mode on, setting their Staff role to Platform admin and back to None grants and revokes it; setting the last platform admin to None is refused with a message.
- [ ] Set a test login to Developer. Signed in as it, `/admin` goes to `/admin-code`; after the code, the nav shows only Overview, Hotels, Pilot health, Users, PMS Access and Docs Questions, and a hotel's page has no buttons or switches.
- [ ] Set it to Sales. After the code, the nav shows only Overview, Hotels, Analytics, Pilot health, Stalled Signups and Docs Questions, and a real hotel's page shows its business numbers. On Analytics, Subscriptions by source says "code" where a signup used one, never the code itself.
- [ ] `/admin/pending-invites` — create another pending invite from a hotel detail page, then Resend and Revoke buttons both work.
- [ ] `/pms/mews/test` still works from a normal user's session (existing UI wasn't touched).

---

## 6. Rollback

If something goes wrong after applying `v2`:

```sql
-- Undo v2 only (leaves v1 in place)
drop function if exists public.platform_grant_role(uuid, public.app_role);
drop function if exists public.platform_revoke_role(uuid, public.app_role);
drop function if exists public.platform_revoke_pending(uuid);
drop function if exists public.platform_remove_membership(uuid, uuid);
drop function if exists public.platform_set_membership_role(uuid, uuid, public.hotel_membership_role);
drop function if exists public.platform_invite_user(citext, uuid, public.hotel_membership_role, uuid);
drop function if exists public.platform_log_event(text, text, text, uuid, jsonb);
drop function if exists public.platform_list_pending_invites(uuid);
drop function if exists public.platform_list_hotels(text);
drop function if exists public.platform_list_hotel_users(uuid);
drop function if exists public.platform_list_users(text, int, int);
drop view if exists public.platform_users_view;
```

The /admin UI will render a "not configured" banner until `v2` is reapplied.

---

## Files added by this PR set

**SQL (root `MAYA/`):**
- `99_supabase_migration_command_center_v2.sql` — new
- `02_supabase_schema.sql` — appended (view + 10 RPCs)

**Next.js app (`MAYA/maya-rms/`):**
- `.env.example` — added `SUPABASE_SERVICE_ROLE_KEY`, `MAYA_INVITE_REDIRECT_BASE`
- `src/utils/supabase/admin.ts` — service-role client factory (server-only)
- `src/lib/admin/require-platform-admin.ts` — auth gate for admin routes
- `src/lib/admin/{types,hotels,memberships,users,pms}.ts` — server-side helpers
- `src/app/admin/layout.tsx` — layout guard
- `src/app/admin/page.tsx` — overview
- `src/app/admin/hotels/page.tsx` — hotels list
- `src/app/admin/hotels/new/page.tsx` — create-hotel wizard host
- `src/app/admin/hotels/[hotelId]/page.tsx` — hotel detail
- `src/app/admin/users/page.tsx` — users list
- `src/app/admin/pending-invites/page.tsx` — pending invites list
- `src/app/auth/accept-invite/page.tsx` — invite landing (set password)
- `src/app/api/admin/hotels/route.ts` — POST create
- `src/app/api/admin/hotels/[hotelId]/pms/mews/route.ts` — PUT / DELETE credentials
- `src/app/api/admin/hotels/[hotelId]/pms/mews/test/route.ts` — POST test
- `src/app/api/admin/hotels/[hotelId]/memberships/invite/route.ts` — POST invite
- `src/app/api/admin/hotels/[hotelId]/memberships/[membershipId]/route.ts` — PATCH / DELETE
- `src/app/api/admin/pending-invites/[pendingId]/route.ts` — POST resend / DELETE revoke
- `src/app/api/admin/pms/mews/test/route.ts` — POST test (wizard-only, no hotel id)
- `src/app/api/admin/users/[userId]/platform-admin/route.ts`: PUT / DELETE grant/revoke platform_admin alone
- `src/app/api/admin/users/[userId]/staff-role/route.ts`: PUT a staff role (the Users page's picker)
- `src/components/admin/{admin-top-nav,status-pill,staff-role-picker,invite-row-actions,hotel-pms-card,hotel-memberships-card,create-hotel-wizard}.tsx`: UI
