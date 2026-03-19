# MAYA RMS - Future Implementation Plan

This document captures the agreed path for tenant onboarding, role modeling, and operational rollout.

## Core Principles

- Auth and tenant access are separate concerns.
- `auth.users` answers identity ("who is the user?").
- Membership tables answer authorization ("what org/hotels can this user access?").
- RLS is the source of truth for data isolation.

## Current State

- Supabase schema and RLS policies are in place.
- Multi-property organizations are modeled (`organizations` -> `hotels`).
- Role scopes are modeled:
  - Organization-level roles (`organization_memberships`) for chain-wide access.
  - Hotel-level roles (`hotel_memberships`) for property-scoped access.
- Next.js app uses Supabase SSR session clients for API access (RLS enforced).

## Why Signup Alone Is Not Enough

A new user in `auth.users` does not automatically belong to an organization.
Without a membership row, that user should see no tenant data (secure-by-default behavior).

## Target Role Model

### Organization Scope

- `super_admin`: full control across all hotels in the organization.
- `org_admin`: org-level management without platform-owner privileges.
- `org_analyst`: read-heavy analytics/reporting access across org.
- `org_viewer`: read-only org visibility.

### Hotel Scope

- `hotel_admin`: manage one or more specific hotels.
- `manager`: operational management for assigned hotels.
- `staff`: limited operational access.
- `viewer`: read-only property access.

## Recommended Rollout Plan

## Phase 1 - Internal Provisioning (Now)

Goal: production-safe onboarding with minimal UI risk.

- Internal/admin process creates:
  - organization
  - hotels under organization
  - initial `super_admin` membership
- Customer users then sign in and are scoped by RLS.
- Use SQL/bootstrap scripts while platform admin UI is not yet built.

Deliverables:
- Seed/provisioning scripts.
- Internal runbook for customer onboarding.
- Validation checklist (membership + RLS visibility tests).

## Phase 2 - Admin Command Center

Goal: remove manual SQL for normal onboarding.

Build a protected internal admin surface:

- Create organization.
- Create hotels for that organization.
- Assign first org `super_admin`.
- Invite/add additional org/hotel users.
- Manage role changes and membership status.

Security requirements:

- Access only for platform operators (strict allowlist/role).
- Audit logging for all provisioning actions.
- No public exposure of provisioning endpoints.

## Phase 3 - Organization Admin Console

Goal: delegate day-to-day user management to customer super admins.

Capabilities:

- Org super admin can:
  - create/manage hotel memberships
  - assign manager/staff/viewer roles
  - manage organization settings
- Hotel admins can manage their own property-level users.

## Phase 4 - Optional Self-Serve Onboarding

Goal: allow fully automated tenant creation by end customers.

Flow:

- User signs up.
- New organization is created automatically.
- User is assigned org `super_admin`.
- Billing/trial workflow is initiated.

Dependencies:

- Abuse protection and verification.
- Billing model finalized.
- Domain ownership/SSO considerations (if needed).

## Data and Policy Governance

- Keep RLS enabled on all tenant tables.
- Never rely on client-side filtering for tenancy boundaries.
- Service-role usage should be limited to internal/provisioning paths only.
- Keep policy tests for:
  - super admin cross-hotel visibility
  - hotel manager single-hotel isolation
  - no-membership user denied access

## Immediate Next Actions

1. Finalize internal onboarding runbook (who provisions and how).
2. Build minimal platform-admin provisioning endpoints/UI.
3. Add a "whoami + my-hotels" diagnostics endpoint for quick access verification.
4. Add integration tests for role isolation under RLS.

## Open Questions

- Should customer organization creation remain internal-only or move to self-serve?
- Do we need invitation flows now (email invite + accept) or later?
- Which actions should require dual approval for platform admins (if any)?
