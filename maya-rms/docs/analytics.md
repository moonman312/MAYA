# Product analytics

What the business needs to know about how properties arrive, get to value,
stay and leave, and how MAYA records it. The panel is `/admin/analytics`; the
raw log is `product_events`; every number on the panel is one SQL function you
can also run by hand.

The headline question, the one this was built for:

```sql
-- How many connected and walked away this week (Monday to today, UTC)
select stage, properties, deferred
  from analytics_walked_away_summary(date_trunc('week', now())::date, current_date);

-- ...and who, so someone can follow up
select property_name, pms_type, connected_at, furthest_stage, walked_away_stage,
       deferred, owner_email, last_activity_at
  from analytics_walked_away(date_trunc('week', now())::date, current_date)
 where outcome = 'walked_away';
```

Both run as-is in the Supabase SQL editor. Through the app they only answer a
platform admin.

## How it is recorded

```
  owner / worker / webhook / Command Center / hand-run SQL
                     │  writes a row it was always going to write
                     ▼
  hotels, hotel_subscriptions, pms_connections, import_jobs, pricing_rules, ...
                     │  AFTER trigger (never fails the write, never slows it
                     │  beyond one indexed insert; errors become a WARNING)
                     ▼
               product_events  ◄── /api/events (a screen viewed, a door opened)
                     ▲          ◄── marketplace_claim_sweep (claim expired)
                     │          ◄── one-time backfill (source = 'backfill')
                     │
  analytics_* functions ──► /admin/analytics, or the SQL editor
```

**Why triggers.** Every write path is captured the same way, including the
Deno workers, the Stripe webhook and anything done by hand, and none of that
code had to learn about analytics.

**Why no foreign keys.** The sweep deletes parked hotels, and everything
hanging off `hotels` cascades. `product_events.hotel_id` is a plain uuid and
each row carries the PMS, the PMS property id and the property name at the
time, so "Seaview Inn connected on Monday and never claimed it" survives the
Seaview Inn row being deleted on Friday.

**Privacy.** Events carry user ids, never emails or names of people, and
nothing from a reservation. Free text never crosses: not the Stripe
cancellation comment, not a room's out-of-service reason, not import error
messages (those become an `error_kind`: auth, rate_limit, timeout,
vendor_error, row_cap, other), not an invite's email. The browser route only
accepts named events with typed properties (a flag, a count, or a word from a
fixed list). The follow-up list resolves `owner_user_id` to an email at read
time, for a platform admin, the same way `platform_list_stalled_signups` does.

**Test properties.** Everything excludes `hotels.is_test` by default (the
panel's "including test properties" link flips it). The flag is copied onto
each event, so a deleted test hotel stays excluded. Account-level events, which
have no hotel, use the `+suffix` email convention the panel already used.

**Who can read.** RLS lets platform admins select `product_events`. Nobody
can update or delete it through the API, the service role included; the
service role may insert (that is `/api/events`). The functions check
`is_platform_admin()` for API callers and allow a direct database session.

## Columns

| column | meaning |
|---|---|
| `occurred_at` | when it happened (for backfill, the best evidence there is) |
| `recorded_at` | when the row was written |
| `event` | `area.what_happened`, see the taxonomy |
| `hotel_id` | plain uuid, may point at a deleted hotel |
| `pms_type`, `pms_property_id` | the PMS property; `cloudbeds` + `320691`. How a swept property that reconnects under a new hotel id is still recognised |
| `property_name` | the hotel's name at the time |
| `user_id` | the person the event is about: the actor for things a person did, the property's owner (earliest active hotel admin) for billing, PMS and import events |
| `properties` | typed details, nulls stripped |
| `source` | `trigger`, `app` (browser), `sweep`, `backfill` |
| `is_test` | `hotels.is_test` at the time |
| `dedupe_key` | only where a retry or re-run must not write twice |

## Event taxonomy

### Acquisition

| event | meaning | emitted by | properties |
|---|---|---|---|
| `account.created` | a MAYA login exists | trigger on `profiles` insert | — |
| `marketplace.connected` | Connect App on Cloudbeds landed and parked a property with a claim ticket; one per click | trigger on `pms_marketplace_claims` insert | `expires_at`, `group_key`, `group_size`, `repeat` (an earlier click for the same property exists) |
| `marketplace.claim_redeemed` | someone signed in and attached the parked property to their account | trigger on `pms_marketplace_claims.claimed_at` | `hours_since_connect`, `group_key`, `group_size` |
| `marketplace.claim_expired` | the ticket expired unredeemed; written by the sweep before it deletes anything | `marketplace_claim_sweep()` | `connected_at`, `expires_at`, `group_key`, `group_size`, `removed` |
| `signup_code.redeemed` | a code was used at checkout | trigger on `signup_code_redemptions` | `code_id`, `code`, `kind`, `percent_off`, `amount_off_cents`, `trial_days` |
| `property.created` | a hotel row exists | trigger on `hotels` insert | `kind`: `marketplace_parked`, `checkout_placeholder` (Flow B's pre-payment row), `active`, `inactive` |

### Billing

| event | meaning | emitted by | properties |
|---|---|---|---|
| `billing.subscribe_viewed` | the subscribe screen rendered | browser | `marketplace`, `restart`, `trial_days`, `group_position`, `group_total` |
| `billing.checkout_started` | checkout answered with a Stripe URL and the browser left for it | browser | `marketplace`, `restart`, `interval`, `rooms`, `has_code` |
| `billing.checkout_cancelled` | Stripe sent them back with `?checkout=cancelled` | browser | `marketplace`, `restart` |
| `billing.portal_opened` | the Stripe customer portal was opened | browser | — |
| `subscription.created` | a subscription attached to a hotel (or replaced a previous one) | trigger on `hotel_subscriptions` | `status`, `resubscribe`, `plan_kind`, `billing_interval`, `billed_rooms`, `trial_end`, `signup_code_id` |
| `subscription.<status>` | the subscription arrived at a status: `trialing`, `active`, `past_due`, `unpaid`, `canceled`, `paused`, `incomplete`, `incomplete_expired` | same | `from_status`, `plan_kind`, `billing_interval`, `billed_rooms`, `trial_end`, `current_period_end`, `cancellation_reason`, `cancellation_feedback` |
| `subscription.cancel_scheduled` | cancel at period end switched on (the owner cancelled in the portal) | same | as above plus `status` |
| `subscription.cancel_withdrawn` | they changed their mind before the period ended | same | same |
| `subscription.plan_changed` | billed rooms or interval changed | same | `previous_billed_rooms`, `previous_billing_interval` plus the current ones |

`cancellation_reason` is Stripe's `cancellation_details.reason`
(`cancellation_requested`, `payment_failed`, `payment_disputed`) and
`cancellation_feedback` is what the owner picked in the portal
(`too_expensive`, `missing_features`, `switched_service`, `unused`,
`customer_service`, `too_complex`, `low_quality`, `other`). The webhook
projection copies both onto `hotel_subscriptions`. Feedback only exists if the
portal's cancellation reasons are switched on in the Stripe dashboard.

`plan_kind = 'internal'` (sandbox, demo, ours) is recorded but excluded from
every billing metric.

### Onboarding and going live

| event | meaning | emitted by | properties |
|---|---|---|---|
| `property.activated` | the hotel became active | trigger on `hotels.is_active` | `via`: `marketplace` (paid for after a claim), `checkout` (Flow B's placeholder adopted at PMS connect), `created`, `reactivated` |
| `property.deactivated` | switched off | same | — |
| `onboarding.path_chosen` | guided or self-serve picked | trigger on `profiles.onboarding_path` | `path` (hotel attached only when the user has exactly one) |
| `onboarding.review_viewed` | the review screen rendered | browser | — |
| `onboarding.questions_completed` | strategy questions answered | trigger on `onboarding_states` | `path` |
| `onboarding.review_completed` | review finished | same | `path` |
| `property.went_live` | simulation mode turned off | trigger on `hotel_settings.simulation_mode` | `first_time` |
| `property.back_to_simulation` | simulation mode turned back on | same | — |
| `marketplace.deferred` | "Not now" on a parked group property | trigger on `hotels.setup_deferred_at` | — |
| `marketplace.resumed` | set up again from the billing page | same | `days_deferred` |
| `property.deleted` | the hotel row was deleted (source `sweep` when the sweep did it) | trigger on `hotels` delete | `was_active`, `was_parked`, `days_since_created` |

### PMS and imports

| event | meaning | emitted by | properties |
|---|---|---|---|
| `pms.connected` | a connection became connected for the first time (from nothing or `pending`) | trigger on `pms_connections.status` | `from_status`, `to_status` |
| `pms.reconnected` | `disconnected` → `connected`: someone re-authorised | same | same |
| `pms.disconnected` | the grant is gone (401, uninstall webhook, vendor said so) | same | same |
| `pms.degraded`, `pms.error` | credential trouble; self-clearing, so at most once per property per 24h | same | same |
| `pms.recovered` | back to connected from degraded or error; at most once per 24h | same | same |
| `import.started` | the worker first claimed a job | trigger on `import_jobs.started_at` | `job_id`, `kind` (`initial` or `refresh`), `phase`, `attempts`, `queued_seconds` |
| `import.completed`, `import.failed`, `import.canceled` | job finished; `canceled` is a job stopped because its connection went away, its owner said "Not now" or its claim was swept | trigger on `import_jobs.status` | the above plus `duration_seconds`, `rows_upserted`, `reservations_enumerated`, `windows_completed`, `error_kind` |
| `property.data_purged` | a claimed Marketplace property that never paid was quiet for 180 days; written just before its imported history, import jobs, open findings, unaccepted invites, credential and connection were deleted | `never_paid_retention_sweep()` (source `sweep`) | `last_activity_at`, `idle_days`, `was_active`, `subscription_status`, `deleted` (row counts by table) |

A Marketplace property's import starts when its owner claims it, before
payment, so `import.started` and often `import.completed` land before
`subscription.created`.

### Engagement

| event | meaning | emitted by | properties |
|---|---|---|---|
| `rule.created` | a pricing rule exists | trigger on `pricing_rules` | `rule_id`, `origin`, `is_active`, `is_pickup_rule`, `action_type`, `action_direction` |
| `rule.enabled`, `rule.disabled` | switched on or off (off keeps its effects) | same | `rule_id`, `origin` |
| `rule.edited` | a behavioural edit (version bump) | same | `rule_id`, `origin`, `version` |
| `rule.deleted` | deleted (effects reverted); not emitted when the hotel itself is deleted | same | `rule_id`, `origin`, `was_active`, `age_days` |
| `manual_price.set` | one save of a typed price, over a range of nights | statement trigger on `manual_price` | `room_type_id`, `nights`, `first_night`, `last_night`, `lead_days` |
| `manual_price.cleared` | one clear | same | `room_type_id`, `nights`, `first_night`, `last_night` |
| `room_type.classified` | a person answered "is this a room?" (the import's guess is not recorded) | trigger on `room_types.counts_as_room` | `room_type_id`, `counts_as_room`, `previous`, `confirmed_guess` |
| `room_type.out_of_service_added` | units taken out for a date range | trigger on `room_type_out_of_service` | `room_type_id`, `units`, `nights`, `starts_in_days` |
| `room_type.out_of_service_cleared` | put back | same | `room_type_id`, `units`, `cleared_early` |
| `explain.opened` | "How did we know?" opened | browser | — |
| `simulator.used` | first change to any rate simulator input in a page load | browser | — |
| `dashboard.tab_opened` | a dashboard tab chosen (this is how the change log and simulator are counted) | browser | `tab` |
| `team.invited` | an invite was sent (or re-sent after revoke) | trigger on `pending_memberships` | `role`, `reinvite` |
| `team.invite_revoked` | invite withdrawn | same | `role` |
| `team.member_joined` | a membership exists | trigger on `hotel_memberships` insert | `role`, `first_member` (the owner), `via_invite` |
| `team.member_removed` | removed; not emitted when the hotel is deleted | trigger on `hotel_memberships` delete | `role`, `removed_by` |

Rule `origin`: `starter` (written by the import worker, no user, while its job
runs, or one of the starter ladder's names), `suggestion` (a signed-in owner
accepted a rule suggestion on the review screen in the previous five minutes),
`owner` (a signed-in person any other way), `system` (no user, e.g. a seed).

Browser events are fire-and-forget, deduplicated to once per page load where
they are "viewed" or "used", rate limited to 60 per user per 10 minutes, and
recorded against the property named in the request only if the caller is a
member of it; otherwise the active-property cookie.

## Metric definitions

All windows are inclusive UTC days. "Now" means the moment the query runs.

### Connected and walked away

**Cohort:** every PMS property whose **first ever** `marketplace.connected`
falls in the window. Repeat clicks do not re-enter a property; a property swept
and reconnected later is the same property. Followed to where it is now.

Each property has one outcome, judged at the furthest stage it reached:

| stage | a property is here when | walked away when |
|---|---|---|
| `connected_never_claimed` | connected, never claimed | its latest ticket has expired |
| `claimed_never_checkout` | claimed, no checkout started, no subscription | nothing has happened for 48 hours (includes "Not now"; `deferred` says which) |
| `checkout_never_subscribed` | sent to Stripe, no subscription | 24 hours on with no activity (a Checkout session's lifetime), or a subscription that ended `incomplete_expired` without trialing or paying |
| `trialed_never_paid` | trialed, never `active` | the subscription is `canceled`, `unpaid`, `paused` or `incomplete_expired`, a cancellation is scheduled, or the PMS is disconnected |
| `paid_then_left` | was `active` at least once | same conditions |

Otherwise the outcome is `in_flight`, or `converted` when it has paid and is
still paying. **Walked away** is the sum of the five stages.

The number for a past week can move: a property that comes back later stops
counting as walked away. That is deliberate, because this is a follow-up list
first and a history second.

Stages reached count as reached even when instrumentation for them came later
(a property with a subscription "started checkout", event or no event).

### Funnels (`analytics_funnel`)

Marketplace, per property, cohort as above: connected → claimed → started
checkout → subscribed → history imported → went live → paying.

Direct, per account, cohort = accounts created in the window that never
claimed a Marketplace property: account created → saw pricing → started
checkout → subscribed → PMS connected → history imported → went live → paying.

Each stage counts only those that reached it **and every stage before it**,
so the bars always narrow. `pct_of_previous` and `pct_of_first` are the
conversions.

### Time to value (`analytics_time_to_value`)

Per property, first occurrence of the earlier event to first occurrence of the
later one, counted in the window the later one landed in. Median and 75th
percentile hours for: connect → claim, claim → subscribe, subscribe → PMS
connected (direct only), subscribe → history imported, imported → live,
connect → live, subscribe → live.

Pairs where the later event came first are left out. Since a Marketplace
import starts at the claim, most Marketplace properties finish importing
before they subscribe, so subscribe → history imported mostly measures direct
signups and the Marketplace imports that were still running at payment.

### Trial conversion (`analytics_trial_conversion`)

Trials whose `trial_end` fell in the window (and has passed). **Converted** =
reached `active` after trialing. **Lost** = latest status `canceled`, `unpaid`,
`paused` or `incomplete_expired` without converting. **Undecided** = neither
yet (typically `past_due` on the first charge). Split into all, Marketplace
(the hotel has any `marketplace.*` event) and direct.

### Retention (`analytics_retention`)

**Paying** = Stripe plan, latest status `active` or `past_due`. A trial is not
paying.

- paying at start / end: paying as of the window's first moment / last moment
- new paying: first ever `active` in the window
- won back: `active` in the window straight after `canceled`, `unpaid` or `paused`, having paid before
- churned: `active`/`past_due` → `canceled`/`unpaid`/`paused` in the window; `rooms_churned` is their billed rooms
- churn %: churned among those paying at the start, over paying at the start
- cancellations scheduled / withdrawn, disconnects, reconnects, and disconnects still not reconnected

### Cancellation reasons (`analytics_cancellations`)

Per kind (`cancel_scheduled`, `canceled`, `unpaid`, `paused`), whether the
property had ever paid, reason and feedback (`not_given` when Stripe has
none), properties and billed rooms.

### Acquisition (`analytics_acquisition`)

Subscriptions started in the window by channel (Marketplace or direct) and
signup code, with where they are now (trialing, paying, lost) and billed rooms.

### Engagement (`analytics_event_counts`)

Every event in the window with occurrences, distinct properties and users, a
`detail` split where it matters (rule origin, dashboard tab, import kind or
failure kind, role, code, activation path) and a `quantity` (nights for manual
prices, units out of service, rows imported). Each event also has a
`detail = '(all)'` row whose property count is counted, not summed.

### Imports and PMS health (`analytics_pms_health`)

Imports started, completed (median minutes and rows) and failed (rate =
failed / finished, broken down by `error_kind`); PMS connected, reconnected,
disconnected, degraded, error, recovered. Plus request-level failure from
`pms_request_log`, which keeps seven days, so that line covers the window's
overlap with the last week and says how many days.

### Groups and "Not now" (`analytics_groups`)

Group grants first connected in the window: size, properties connected,
claimed, subscribed, deferred now, expired unclaimed.

### Right now (`analytics_book`)

Active properties; paying, trialing, past due, internal; live vs simulating
among entitled; billed rooms paying and trialing; measured rooms across active
properties (`counts_as_room` not false); Marketplace properties awaiting a
claim, expired awaiting the sweep, deferred.

**MRR.** Taken from the newest `hotel_metrics_daily` snapshot, list and net,
not re-derived in SQL. It is honest as a steering number: month-equivalent
list price from the price brackets in `lib/billing/tiers.ts` (the same ones
pushed to Stripe), trials excluded, signup-code discounts netted off. It is not
cash: a repeating discount whose months have run out is still netted, and
prorations, tax, refunds and failed charges are invisible. Stripe's invoices
are the only record of money collected and are not mirrored. Re-deriving it in
SQL would mean a second copy of the brackets, which is how the two would drift.

## The expired claim sweep

`marketplace_claim_sweep()` runs daily (see
`supabase/cron/marketplace-claim-sweep.sql.example`). For every unredeemed claim
more than 3 days past its expiry it records `marketplace.claim_expired`, then
deletes the parked hotel and its group siblings only while they are untouched
(still parked; no membership, invite, subscription or import; nothing written
in the grace period), removing the credential through `pms_secret_delete`, the
connection rows and the claim. Parked Marketplace hotels whose claim insert
failed at connect are removed on the same test. `select
marketplace_claim_sweep(interval '3 days', true)` previews without writing.
The migration explains the grace period and what is left behind at Cloudbeds.

## The never-paid retention sweep

`never_paid_retention_sweep()` runs daily (see
`supabase/cron/never-paid-retention-sweep.sql.example`). A claimed Marketplace
property that has never paid (`hotel_subscriptions.first_paid_at` null, nothing
trialing, active or past due, not an internal plan) and has not seen a person
for 180 days gets `property.data_purged`, then loses its imported history and
the rows derived from it, its import jobs, open findings, unaccepted invites,
its PMS credential and its connection row. The property, members, rules, room
types and their classifications, closed periods and answered findings stay.

"Seen a person" is the latest of the hotel's creation, the claim, any
`product_events` row `product_event_by_person()` accepts (browser events, and
the trigger events only a person causes: a claim, "Not now", a rule edit, a
typed price, a room answer, an invite, a checkout), any
`platform_audit_events` row with an actor, and the Marketplace audit lines
(Connect App clicked again, claimed, paid). Imports, syncs, PMS health,
Stripe's own status changes and room truing never reset it. `select
never_paid_retention_sweep(p_dry_run => true)` lists what would go and writes
nothing; the migration header lists every table kept and deleted.

## Backfill

The events migration seeds history once, into an empty log, from the tables
and `platform_audit_events`. Those rows have `source = 'backfill'`; where the
moment is not stored anywhere they carry `approximate: true`:

- exact: accounts, Marketplace connects and claims (audit log and claims), deferrals, disconnects and reconnects from the audit log, subscription creation, imports, manual prices, out-of-service, invites and memberships, onboarding completions
- approximate: subscription status changes (from the nightly snapshot, to the day, or the row's last update), a scheduled cancellation, went live (settings last updated), activation outside Flow A (the onboarding connect time), path chosen, rule origin (inferred from the starter names)
- not recoverable: checkout started, screens viewed, rule toggles and edits before today, cancellation reasons before today, and connects of properties deleted before Flow A logged them

## Seams

Places this cannot see yet, because the code that would record them is owned
elsewhere right now:

- **Checkout started, server side.** `billing.checkout_started` comes from the
  browser after `/api/billing/checkout` answers. A one-line
  `product_event_emit` in that route after the Stripe session is created would
  make it independent of the browser.
- **The sign-in and claim screen** (`src/app/login/page.tsx`): "claim link
  opened", "claim link expired", "signed up to claim" and "signed in to claim"
  would split `connected_never_claimed` into never came back vs came back and
  bounced.
- **Invite accepted** (`src/app/auth/accept-invite/page.tsx`): the membership
  trigger records the join; the screen could record the invite being opened.
- **Terms acceptance.** When `terms_acceptances`
  (`99_supabase_migration_terms_acceptance_v1.sql`) lands, a trigger on it
  emitting `account.terms_accepted` belongs in the next events migration.
- **Connect-time failures in Flow A** (`lib/pms/marketplace-connect.ts`): a
  connect that fails before a claim is inserted leaves no event. Logging
  `marketplace.connect_failed` there would count Connect App clicks that never
  became a ticket.
- **Marketing attribution** (the marketing site): no UTM or referrer reaches
  the app, so direct signups cannot be split by campaign.
