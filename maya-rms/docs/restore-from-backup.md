# Restoring the database from a backup

Internal runbook (audit A30). Read it all once before you need it. On the day,
work through it in order and tick each step.

## The facts

- **Backups:** Supabase takes one backup of the database a day and keeps each
  for **7 days** (Pro plan). The Dashboard lists them, with the time each was
  taken, under **Database > Backups**.
- **No point-in-time recovery (PITR).** The database can only go back to the
  moment one of those daily backups was taken.
- **Region:** the project is in **US East (Ohio)**. A backup lives in the same
  region.
- **An in-place restore replaces the whole database** with the backup and the
  project is **inaccessible while it runs**; how long depends on the size of
  the database. Supabase asks for confirmation before it starts.
- **Not in the database, so a restore does not touch them:** the deployed
  edge functions and their secrets (Edge Function Secrets), the Supabase Auth
  settings (URL configuration, email/SMTP, templates, MFA), Storage files, and
  everything on Vercel (the app and its environment variables).
- **In the database, so a restore puts them back as they were at the backup:**
  every table, the Auth users (`auth.users`: sign-ups, password changes and
  MFA enrolments after the backup are gone), the Vault secrets (the webhook
  addresses, cron secrets and every hotel's stored PMS sign-in), and the
  pg_cron jobs (`cron.job`), including whether each one is switched on.
- **Custom role passwords** are not in a daily backup and must be reset
  afterwards. MAYA has no custom login roles today; if one is ever added, reset
  its password after a restore.

## What a restore loses

Everything written to the database after the backup was taken, which is up to
a day (more if a backup was skipped). For MAYA that means:

- **Owners' work in MAYA:** rules created or edited, floors and ceilings,
  manual prices, rooms out of service, room type answers, team invitations and
  role changes, God Mode records.
- **Accounts and properties:** anyone who signed up after the backup has no
  login and no property. If they paid, Stripe still charges them.
- **Billing records:** `hotel_subscriptions` goes back to the backup. Stripe
  keeps the truth, but MAYA no longer knows about payments, cancellations,
  card changes or new subscriptions since then.
- **What MAYA sent to each property system:** the ledger (`rate_updates`) goes
  back, while the property system still holds the prices MAYA sent after the
  backup. See [Live hotels](#live-hotels-what-maya-sent-after-the-backup).
- **Stored PMS sign-ins:** Vault goes back to each hotel's token from the
  backup time. A vendor that replaces its refresh token each time it is used
  has since retired that one, so the connection fails with `invalid_grant`
  and the owner has to reconnect. Whether Cloudbeds and ThinkReservations do
  this is still to be confirmed with them.
- **Bookings:** not lost for good. Each connection's watermark
  (`pms_connections.reservations_modified_through`) also goes back to the
  backup, so the next sync re-reads every booking changed since then.
- **Logs and analytics** after the backup: `product_events`,
  `pms_request_log`, the signups feed, the change log's PMS lines.
- **Emails' "already sent" marks:** a few emails (the account ready email, a
  connection down notice) can go out a second time.

## First decide: full restore, or repair from a copy?

A full in-place restore loses a day for every hotel. Most incidents (a bad
`update`, a deleted rule, one table damaged) only need some rows back.

- **Some rows damaged, the rest fine:** do not restore in place. On
  **Database > Backups**, open the **Restore to a New Project** tab, pick the
  backup and click **Restore**. That makes a separate project from the backup
  while MAYA keeps running. Copy the rows you need back into the live database
  (Claude writes the copy-back SQL for the tables involved, checked against
  that day's columns), then delete the new project. A new project copies the
  database and the Vault key, but not edge functions, Auth settings, API keys
  or Storage, so never point the app at it.

  **The new project starts running its copy of the jobs at once.** Supabase
  says these jobs start as soon as the restore completes and cannot be left
  out or paused beforehand. The copy carries Vault, so its pg_cron jobs call
  the **live** project's edge functions and the **live** app's billing routes
  with valid secrets, and its `pricing_watchdog`, seeing no pricing run after
  the backup, posts critical "behind" alerts for every hotel to the real
  Slack channel after about 30 minutes. So the moment the new project is up,
  before anything else, open its SQL editor and run:

  ```sql
  -- In the NEW project only. Its copy of every job, paused.
  select jobname, cron.alter_job(jobid, active := false) from cron.job where active;
  ```

  ```sql
  -- In the NEW project only. Point its copy of every address and secret at
  -- nothing, so a job that slips through reaches nobody and is refused.
  select name, vault.update_secret(id, 'disabled-in-restored-copy')
    from vault.secrets
   where name in ('project_url', 'maya_app_url', 'maya_alert_webhook', 'maya_signups_webhook',
                  'cloudbeds_cron_secret', 'think_cron_secret', 'mews_cron_secret',
                  'onboarding_cron_secret', 'billing_cron_secret');
  ```

  Check you are in the new project (its name and reference are at the top of
  the Dashboard) before you run either. A "behind" alert in Slack before you
  get there is from the copy and can be ignored.

  This tab needs **physical backups** on the live project, which Supabase
  uses for every project on Postgres 15.8.1.079 or newer (the version is on
  **Settings > Infrastructure**). Physical backups cannot be downloaded. If
  the tab is not offered, there is no partial repair from Supabase's backup:
  ask Supabase support, or repair the rows by hand from what you know, or do
  the full restore below.
- **The database is lost or broken throughout:** restore in place, below.

## Before the restore

1. **Pick the backup.** On **Database > Backups**, choose the newest backup
   taken before the damage. Write down its time in UTC: the steps below call it
   the **backup time**.

2. **Pick the moment.** Avoid 08:40 to 09:30 UTC, when the daily sweeps run
   (request log, engine data, Marketplace claims, never-paid retention, room
   count truing). Tell the pilot hotels that MAYA will be down for a while and
   that anything they change in MAYA from the backup time on will be lost.

3. **Cut the syncs off and turn sending off.** Sending off alone is not
   enough: it stops prices going out, not the reads, and after the restore
   the first read is what does the damage. Every scheduled tick re-reads
   each hotel's rates before it decides whether to send
   (`ensureBaseRateCalendar` runs ahead of the push in `pricing-tick.ts`),
   and the restored rates are up to a day old, so the first tick re-reads
   every hotel's whole window. For a Live hotel it then takes nights MAYA
   sent to after the backup as the hotel's own changes (see
   [Live hotels](#live-hotels-what-maya-sent-after-the-backup)). The restored
   sync jobs fire within 5 minutes of the project coming back, before you can
   pause them, and any owner or staff edit in the app calls the syncs
   directly from Vercel (`src/lib/pms/sync-nudge.ts`). So the syncs must
   refuse every caller until the ledger is put right.

   First, open MAYA's **Admin > Pilot health** and write down its
   **Sending** line, for example "Sending: Cloudbeds on (MAYA_PUSH_RATES).
   ThinkReservations off (MAYA_PUSH_RATES_THINK)." It names the setting in
   force for each system; step 18 puts them back from it.

   Then in the Supabase Dashboard, **Edge Function Secrets** (or
   `npx supabase secrets set ...` from `maya-rms/`), set:

   - `MAYA_PUSH_RATES_CLOUDBEDS` = `false`
   - `MAYA_PUSH_RATES_THINK` = `false`
   - `CLOUDBEDS_CRON_SECRET`, `THINK_CRON_SECRET` and `MEWS_CRON_SECRET` =
     one new random value (`openssl rand -hex 32`), not written down
     anywhere.

   Functions read a new secret at once, with no redeploy, and these secrets
   are outside the database, so the restore cannot undo them. From here on
   the three syncs answer every caller with 401: the pg_cron jobs (Vault, now
   and after the restore, still holds the old values) and the app's nudges
   (Vercel holds the old values too). Nothing is read, priced or sent for any
   hotel until step 14 lets them back in. The old values are not lost: they
   are still in Vault and on Vercel. `false` on each system's own sending
   switch also overrides the older shared `MAYA_PUSH_RATES`, as a second
   lock.

   Check it took: on **Edge Functions > cloudbeds-scheduled-sync >
   Invocations**, the next five-minute tick answers 401.

4. **Write down what is there now** (skip what fails if the database is too
   broken to answer). In the SQL editor:

   ```sql
   -- The scheduled jobs and whether each is on: the restore brings back the
   -- backup's copy, and the end of this runbook puts these back.
   select jobid, jobname, schedule, active from cron.job order by jobname;
   ```

   ```sql
   -- The Vault secrets by name (never the values). The PMS sign-ins are
   -- left out: there is one per connection.
   select name, updated_at from vault.secrets where name not like 'pms:%' order by name;
   ```

   ```sql
   -- How much the restore will lose. Put the backup time in the first line.
   with t as (select timestamptz '2026-10-01 02:00:00+00' as backup_at)
   select 'properties created' as what, count(*) as lost from public.hotels, t where created_at > backup_at
   union all select 'people who signed up', count(*) from auth.users, t where created_at > backup_at
   union all select 'subscriptions changed', count(*) from public.hotel_subscriptions, t where updated_at > backup_at
   union all select 'rules created or edited', count(*) from public.pricing_rules, t where updated_at > backup_at
   union all select 'manual prices set', count(*) from public.manual_price, t where set_at > backup_at
   union all select 'prices sent to a property system', count(*) from public.rate_updates, t where status = 'sent' and pushed_at > backup_at
   order by what;
   ```

   ```sql
   -- The Live hotels (in simulation nothing is ever sent).
   select h.id, h.name, c.pms_type, c.status as connection, s.status as subscription
     from public.hotels h
     join public.hotel_settings hs on hs.hotel_id = h.id and hs.simulation_mode = false
     left join public.pms_connections c on c.hotel_id = h.id
     left join public.hotel_subscriptions s on s.hotel_id = h.id
    where not h.is_test
    order by h.name;
   ```

   And list the function secrets by name: `npx supabase secrets list`
   (it prints names and digests, never values). Keep the list: whether
   `MAYA_PUSH_RATES_CLOUDBEDS` and `MAYA_PUSH_RATES_THINK` were on it is how
   step 18 knows whether each was set before step 3.

5. **Save a copy of the database as it is now**, if it can still be read.
   The restore overwrites it for good, and it is the only record of the
   prices sent, the manual prices and the hotels' own rates after the backup.
   `supabase db dump` runs `pg_dump` in a Docker container, so **Docker
   Desktop must be running**. From `maya-rms/`:

   ```bash
   npx supabase db dump --linked -f before-restore-schema.sql
   npx supabase db dump --linked --data-only -f before-restore-data.sql
   ```

   Without Docker, run `pg_dump` directly, of the same major version as the
   database or newer, with the connection string from the Dashboard's
   **Connect** button (Session pooler) and the database password:

   ```bash
   pg_dump "postgresql://postgres.<project-ref>:<password>@<pooler-host>:5432/postgres" \
     --schema=public --data-only -f before-restore-data.sql
   ```

   Either way the copy holds the `public` tables: enough for `rate_updates`,
   `manual_price` and `base_rate_calendar` (step 13). It does not hold
   `auth` (sign-ups and logins), `vault` or `cron`: step 4's counts and
   lists are the only record of those.

   Keep the files out of the repo (they hold customer data) and delete them
   once the restore is settled.

## The restore

6. On **Database > Backups**, choose the backup from step 1, click
   **Restore** and confirm. Wait until the Dashboard shows the project healthy
   again. The app shows errors meanwhile. Stripe retries any webhook it could
   not deliver for up to 3 days, so those catch up on their own.

## Straight after the restore, before anything else

7. **Pause every scheduled job.** The restore brought back the backup's jobs,
   switched on. First thing in the SQL editor:

   ```sql
   select jobname, cron.alter_job(jobid, active := false) from cron.job where active;
   ```

   The sync jobs that fired before this were refused (step 3), so nothing
   was read or sent. The others were not cut off: a `pricing-watchdog` tick
   in that gap can post "behind" alerts for every hotel to Slack, because no
   pricing has run since the backup (ignore them), and a
   `billing-card-reverify` tick can re-check a card against subscription
   records that are back at the backup, which moves no money. Step 13 checks
   that no read slipped through.

8. **Check the restore took, and nothing is running.** Put the backup time in
   the first line. Every row should say `true`:

   ```sql
   with t as (select timestamptz '2026-10-01 02:00:00+00' as backup_at)
   select * from (
     select 1 as ord, 'every scheduled job paused' as check,
            not exists (select 1 from cron.job where active) as pass
     union all
     select 2, 'no price sent after the backup (the ledger went back)',
            not exists (select 1 from public.rate_updates, t where pushed_at > backup_at + interval '1 hour')
     union all
     select 3, 'no subscription change after the backup',
            not exists (select 1 from public.hotel_subscriptions, t where updated_at > backup_at + interval '1 hour')
     union all
     select 4, 'alert and signups webhooks are in Vault',
            (select count(*) from vault.secrets where name in ('maya_alert_webhook', 'maya_signups_webhook')) = 2
     union all
     select 5, 'every stored PMS sign-in is still in Vault',
            not exists (select 1 from public.pms_connection_secrets p
                          left join vault.secrets v on v.id = p.vault_secret_id
                         where v.id is null)
   ) checks order by ord;
   ```

   Rows 2 and 3 allow an hour past the backup time, because the listed time
   is when the backup started.

## Put back what lives outside the database

9. **Edge functions.** Dashboard, **Edge Functions**: `cloudbeds-scheduled-sync`,
   `think-scheduled-sync`, `mews-scheduled-sync` and `onboarding-import-worker`
   are all there. `npx supabase secrets list` shows the same names as in step
   4. It cannot show values: whether sending is off shows on Pilot health
   once the syncs run again (step 17).

10. **Vault secrets.** Run step 4's Vault query again and compare. Every name
    should be back. Any secret changed after the backup is back to its old
    value; set it again (`vault.update_secret`). Check in particular:

    - `maya_alert_webhook` and `maya_signups_webhook`. Send a test line to
      #maya-signups with `select public.signup_feed_test();` (it answers
      `ready` when the post was queued). Alerts are checked on Pilot health
      in step 17.
    - the cron secrets and `project_url` / `maya_app_url`.
      `cloudbeds_cron_secret`, `think_cron_secret` and `mews_cron_secret`
      must equal `CLOUDBEDS_CRON_SECRET`, `THINK_CRON_SECRET` and
      `MEWS_CRON_SECRET` on Vercel (the app's nudges use those); step 14 puts
      the functions' own back to the same values. `onboarding_cron_secret`
      must equal `ONBOARDING_CRON_SECRET` in Edge Function Secrets and on
      Vercel, and `billing_cron_secret` must equal `BILLING_CRON_SECRET` on
      Vercel, or that job is refused. If one was rotated after the backup,
      Vault now holds the old value: set it again to the value in use.

11. **Supabase Auth settings.** An in-place restore leaves them alone, but
    check, as `docs/command-center-deployment.md` sets them up:
    **Authentication > URL Configuration** (site URL and redirect allowlist),
    the SMTP settings (Resend) and email templates, and TOTP MFA on. Then sign
    in to MAYA with an owner login and with a staff login (MFA).

12. **Stripe.** MAYA's subscription rows are back at the backup; Stripe is
    right. In the Stripe Dashboard (live), look through the events since the
    backup time for the `customer.subscription.*` types,
    `checkout.session.completed` and `invoice.payment_succeeded`. For each
    subscription they name, resend to MAYA's live webhook endpoint its newest
    `customer.subscription.*` or `checkout.session.completed` event, and its
    newest `invoice.payment_succeeded` event if there is one, with the Stripe
    CLI: `stripe events resend evt_... --webhook-endpoint=we_... --live`
    (the endpoint id is on the endpoint's page in the Dashboard). The webhook
    reads the subscription fresh from Stripe and saves it, so the newest
    event is enough. The payment event is what stamps the property's first
    payment (the never-paid retention sweep's "has ever paid" mark) and
    clears the "Your saved card stopped working" warning; without it, a
    property that paid after the backup shows that warning again and counts
    as never paid until its next payment. The handlers are safe to run twice.
    Stripe resends events up to 30 days old.

    - A resend that answers 500 is almost always a subscription whose
      property was created after the backup: the property no longer exists.
      That owner paid and has no account. Email them, and decide with them
      whether to refund or to set them up again.
    - Resending can send the account ready email a second time to an owner
      who paid after the backup.

## Live hotels: what MAYA sent after the backup

While every hotel is in simulation, nothing was sent, so skip to step 14.

For a Live hotel, the property system still holds every price MAYA sent after
the backup, while MAYA's ledger (`rate_updates`) is back at the backup. The
first rate read would then get both kinds of night wrong:

- a night MAYA had sent to before the backup and sent to again after it reads
  as the **hotel's own change**: it becomes a manual price at MAYA's later
  price ("Changed in Cloudbeds" in the change log), and rules stack on top;
- a night MAYA first sent to after the backup has no record at all, so MAYA
  takes its price as the **hotel's own rate**, and the rules raise (or cut)
  it a second time.

So no Live hotel's rates may be read until its ledger is put right. Step 3
keeps every read off until step 14.

13. **Put the ledger right.**

    - **If step 5 saved the old database:** the copy holds every price sent
      after the backup. Claude loads it into a scratch database and writes the
      copy-back: each saved `rate_updates` row replaces the restored row for
      the same hotel, room type and night when the saved one is newer
      (`updated_at`), and is added when there is none. Run it, then check that
      no Live hotel has a sent price newer in the copy than in the ledger.
    - **If nothing could be saved:** MAYA cannot tell its own lost prices from
      the hotel's changes. Work it out with Claude per hotel before going on
      to step 14, which lets every hotel be read again: the hotel's own rates
      as of the backup are still in `base_rate_calendar` and must not be
      overwritten by the first read. Expect to tell the hotel that changes it
      made in its property system after the backup may be written over.

    Then make sure no read slipped through (a tick that ran before step 3
    took effect, say). Put the backup time in the first line. Every count
    should be 0:

    ```sql
    with t as (select timestamptz '2026-10-01 02:00:00+00' + interval '1 hour' as after_backup)
    select 'manual prices taken from a rate read' as what, count(*) as found
      from public.manual_price, t where source = 'pms' and set_at > after_backup
    union all select 'hotel rates read into the calendar', count(*)
      from public.base_rate_calendar, t where captured_at > after_backup
    union all select 'connections read', count(*)
      from public.pms_connections, t where last_sync_at > after_backup
    order by what;
    ```

    If any is not 0, a read got in. For a Live hotel, a `manual_price` row
    with source `pms` set after the backup is a price MAYA sent after the
    backup, misread as the hotel's own change, and a `base_rate_calendar`
    row captured after it may hold MAYA's price as the hotel's own rate.
    Claude writes the cleanup for those rows: each is put back to what the
    step 5 copy holds for the same hotel, room type and night, which is the
    hotel's own rate and the manual prices as they were just before the
    restore. Without a copy, clear the misread manual prices and agree each
    affected night's rate with the hotel. A hotel in simulation needs
    nothing: its next read sets it right.

## Start again

14. **Let the syncs back in.** Only once step 13 is done for every Live
    hotel. Put each sync's cron secret in Edge Function Secrets back to the
    value Vault holds (which step 10 checked against Vercel). In the SQL
    editor, read them:

    ```sql
    select name, decrypted_secret from vault.decrypted_secrets
     where name in ('cloudbeds_cron_secret', 'think_cron_secret', 'mews_cron_secret');
    ```

    and set them, without pasting them anywhere else:
    `npx supabase secrets set CLOUDBEDS_CRON_SECRET=... THINK_CRON_SECRET=... MEWS_CRON_SECRET=...`
    Sending stays off: the two `MAYA_PUSH_RATES_*` switches are still
    `false`.

15. **Resume the scheduled jobs**, the ones that were on in step 4:

    ```sql
    -- Put the names from step 4 in the list.
    select jobname, cron.alter_job(jobid, active := true)
      from cron.job
     where jobname in ('cloudbeds-sync-every-5-min', 'think-sync-every-5-min', 'mews-sync-every-5-min',
                       'onboarding-import-worker-every-min', 'pricing-watchdog-every-10-min',
                       'billing-card-reverify', 'billing-room-truing', 'business-metrics-snapshot',
                       'rate-push-incident-sweep', 'pms-request-log-sweep', 'engine-data-sweep',
                       'marketplace-claim-sweep', 'never-paid-retention-sweep');
    ```

    Turn `billing-room-truing` and `never-paid-retention-sweep` on only after
    step 12 is done: both act on subscription records.

16. **Watch the first reads** (about 10 minutes). Each connection catches up
    on the bookings changed since the backup by itself. Then:

    ```sql
    select * from (
      select 1 as ord, 'every connected property read in the last 15 minutes' as check,
             not exists (select 1 from public.pms_connections
                          where status = 'connected'
                            and (last_sync_at is null or last_sync_at < now() - interval '15 minutes')) as pass
      union all
      select 2, 'no connection failing',
             not exists (select 1 from public.pms_connections where status in ('error', 'degraded')) as pass
    ) checks order by ord;
    ```

    A connection in `error` whose log says `invalid_grant` needs its owner to
    reconnect (the vendor retired the token Vault went back to). Tell them.

17. **Pilot health.** Open MAYA's **Admin > Pilot health**. Every hotel should
    read fine, the alert channel should be ready, and the **Sending** line
    should read off for both systems, naming `MAYA_PUSH_RATES_CLOUDBEDS` and
    `MAYA_PUSH_RATES_THINK` (the first sync tick reports it).
    `select * from public.pricing_watchdog(false);` lists any hotel whose
    pricing is behind, without posting an alert.

18. **Turn sending back on.** Only when steps 13, 16 and 17 are clean. Put
    each switch back as it was before step 3, from the Sending line written
    down there and step 4's list of secret names:

    - **Cloudbeds.** If `MAYA_PUSH_RATES_CLOUDBEDS` was not on step 4's list
      (the Sending line named `MAYA_PUSH_RATES`), unset it:
      `npx supabase secrets unset MAYA_PUSH_RATES_CLOUDBEDS`, and the shared
      `MAYA_PUSH_RATES` decides again. If it was on the list, set it to
      `true` or `false` as the Sending line said (on or off).
    - **ThinkReservations.** If `MAYA_PUSH_RATES_THINK` was not on step 4's
      list, unset it (off until set). If it was, set it to `true` or `false`
      as the Sending line said.

    On the next tick Pilot health's Sending line matches the one from step 3,
    and the Live hotels' sent counts move again.

19. **Tell people.** Each pilot hotel: what they set in MAYA after the backup
    time is gone and needs doing again. Anyone from step 12 who paid and lost
    their account. Then delete the step 5 files.

## Point-in-time recovery: the decision

**Decided (Jake): stay on daily backups while only a few hotels are live, and
buy point-in-time recovery once several hotels are live.**

What it changes, from Supabase's docs:

- A restore can go to any second in the retention window. Backups of the
  write-ahead log are taken every two minutes by default, so the worst case
  loses about **2 minutes** instead of up to a day.
- It costs about **$100 a month** for 7 days of retention (about $200 for 14,
  about $400 for 28), on top of the plan, and needs at least the **Small
  compute add-on**.
- Once it is on, Supabase stops taking daily backups: PITR replaces them.
- It is switched on under the project's point-in-time settings in the
  Dashboard.

Why it matters for MAYA in particular: the lost window is what makes the
ledger repair in step 13 necessary. With minutes lost instead of a day,
almost nothing sent goes missing from the records, and very few owners lose
any work.

When it is bought, update this runbook (steps 1 and 6 pick a time instead of
a backup) and the customer docs that say there is no point-in-time restore:
`content/docs/reference/privacy-security-and-your-data.mdx`, and the Terms and
Privacy Policy on get-maya.com.
