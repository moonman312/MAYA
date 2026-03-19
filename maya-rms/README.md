# MAYA RMS (Next.js)

React/Next.js migration scaffold of the original Python MAYA dashboard.

## Stack

- Next.js (App Router, TypeScript)
- Tailwind CSS
- Supabase (`@supabase/supabase-js` + `@supabase/ssr`)

## Current Feature Parity

- Calendar view with occupancy thresholds and room-type drilldown
- Rules CRUD (add/toggle/delete)
- Rate simulator using enabled rules
- Change log feed
- API routes mirroring the Python local GUI behavior

## Supabase Integration Mode

Rules API supports two modes:

1. **Supabase-backed** (if env vars are provided and schema exists)
2. **In-memory fallback** (no DB required for initial dev)

`GET /api/health` shows which mode is active.

When Supabase mode is enabled, server queries are created from the user session
cookie (`@supabase/ssr`) so RLS policies enforce tenant boundaries.

## Environment

Copy `.env.example` to `.env.local` and fill in values:

```bash
cp .env.example .env.local
```

Required for full Supabase mode:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` (or `NEXT_PUBLIC_SUPABASE_ANON_KEY`)
- `MAYA_DEFAULT_HOTEL_ID`

## Run

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Auth Flow

- Visit `/login` to sign in or create an account.
- API routes use Supabase SSR session cookies (`@supabase/ssr`) so RLS is applied per user.
- Tenant visibility is determined by `organization_memberships` and `hotel_memberships`.

## Demo Data Source Of Truth

For DB-backed calendar/rules testing, run SQL scripts in this order:

1. `supabase_base_schema.sql`
2. `supabase_schema.sql`
3. `supabase_seed.sql`
4. `supabase_demo_data.sql` (synthetic reservations + occupancy metrics)

After step 4, calendar data is sourced from Supabase tables (with demo fallback only when DB data is unavailable).

## Notes

- The pricing logic and demo datasets are ported from the Python implementation.
- The migration focuses on preserving core behavior while moving to a React-first architecture.
- Middleware is included to refresh Supabase auth sessions for SSR route handlers.
