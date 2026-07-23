# Resend invite email setup

As of this change, **Supabase Auth no longer sends invite emails**. The app
generates the invite link itself (`auth.admin.generateLink`) and sends its own
email through [Resend](https://resend.com). The email is rendered in
`maya-rms/src/lib/email/invite-email.ts` and styled to match the app
(slate-950/900 dark card, sky-500 CTA) with the same personalization the old
Supabase template metadata carried (hotel name, role, inviter email).

## What changed in code

| File | Change |
| --- | --- |
| `src/lib/email/resend.ts` | New. Fetch-based Resend API client (`sendEmail`). No SDK dependency. |
| `src/lib/email/invite-email.ts` | New. Invite email subject/HTML/text renderer. |
| `src/lib/admin/memberships.ts` | `inviteUserToHotel` and `resendInviteEmail` now call `auth.admin.generateLink` (which creates the auth user but sends **no** email) and send the email via Resend. If the address is already a confirmed user, resend falls back to a magic-link. |
| `src/app/auth/accept-invite/page.tsx` | Now redeems `?token_hash=…&type=…` links via `verifyOtp` (Resend-era links). The old `?code=…` PKCE path is kept as a fallback for any not-yet-clicked Supabase-sent links. |
| `.env.example` / `.env.local` | Added `RESEND_API_KEY`, `RESEND_FROM_EMAIL`. |

Flow (unchanged from the user's perspective): admin invites → email arrives →
link lands on `/auth/accept-invite` → session created → user sets password →
`trg_accept_pending_memberships` materializes the membership. The auth user
row is still created at invite time (by `generateLink`), same as before with
`inviteUserByEmail`, so the trigger path is untouched.

## 1. Create the Resend account & API key

1. Sign up at <https://resend.com/signup> (free tier: 3,000 emails/month,
   100/day at time of writing).
2. Dashboard → **API Keys** → *Create API Key*.
   - Name: `maya-rms` (one per environment is good hygiene: `maya-rms-dev`,
     `maya-rms-prod`).
   - Permission: **Sending access** is sufficient.
3. Copy the key (shown once) into `.env.local`:

   ```bash
   RESEND_API_KEY=re_xxxxxxxxxxxx
   ```

## 2. Sender address

**Before a domain is verified** you can send from `onboarding@resend.dev`, but
Resend only delivers those to the email address that owns the Resend account —
fine for dev, useless for real customers.

```bash
RESEND_FROM_EMAIL=MAYA <onboarding@resend.dev>
```

**For production**, verify a domain:

1. Dashboard → **Domains** → *Add Domain* → e.g. `mail.your-domain.com`
   (a subdomain keeps your root domain's reputation isolated — recommended).
2. Add the DNS records Resend shows you at your DNS provider:
   - SPF (TXT) and DKIM (TXT/CNAME) — required.
   - DMARC (TXT) — recommended: `v=DMARC1; p=none;` to start.
3. Wait for the dashboard to show **Verified** (usually minutes, up to a few
   hours depending on DNS TTL).
4. Set:

   ```bash
   RESEND_FROM_EMAIL=MAYA <invites@mail.your-domain.com>
   ```

   The mailbox doesn't need to exist; only the domain must be verified.

## 3. Vercel / production env

Add both variables in Vercel → Project → Settings → Environment Variables
(Production + Preview). They are server-only; never prefix with
`NEXT_PUBLIC_`.

## 4. Supabase-side cleanup (one-time)

Nothing is required for the new flow to work, but tidy up:

- **Authentication → Email Templates → Invite user** — now unused by the app.
  Optional: edit it to say "You shouldn't receive this" so a stray dashboard
  "Invite user" click is obvious.
- **Authentication → URL Configuration** — keep `MAYA_INVITE_REDIRECT_BASE`
  host allowlisted; the accept page URL is still on that host.
- Avoid the dashboard's manual **Invite user** button going forward — it sends
  Supabase's own email through Supabase SMTP with the default template. Use
  the Command Center instead.
- OTP expiry for invite links is controlled by Supabase (Authentication →
  Providers → Email → *Email OTP expiration*, default 24 h / 86400 s).

Note: the login page's self-signup (`supabase.auth.signUp`) still uses
Supabase's built-in confirmation email. If public sign-ups get disabled per
the deployment doc (§3.3), that path disappears entirely; otherwise moving it
to Resend is a separate, similar refactor.

## 5. Smoke test

1. `npm run dev` with `RESEND_API_KEY` + `RESEND_FROM_EMAIL` set.
2. `/admin` → a hotel → invite **your own email** (the one on your Resend
   account if you're still on `onboarding@resend.dev`).
3. Email arrives from Resend (check Resend Dashboard → **Emails** for the
   delivery log). Dark card, "Accept the invite" button.
4. Click → `/auth/accept-invite?token_hash=…&type=invite` → set password →
   redirected to `/`.
5. Verify membership materialized (Members card shows the user; pending
   invite row gone/accepted).
6. `/admin/pending-invites` → **Resend** on a pending invite → second email
   arrives.

## Troubleshooting

- **"Resend is not configured"** — env vars missing in that environment.
- **403 from Resend** — sending from an unverified domain, or a
  `resend.dev` address to someone other than your own account email.
- **429** — free-tier daily cap (100/day) hit.
- **"Supabase invite link generation failed: … already been registered"** on
  first invite (not resend) — the user exists in `auth.users`; the code
  intentionally skips email for existing users, so this indicates
  `platform_users_view` and `auth.users` disagree — investigate.
- **Invite link "expired or invalid"** — token hash was already redeemed or
  older than the OTP expiry; use Resend button to issue a fresh one.
