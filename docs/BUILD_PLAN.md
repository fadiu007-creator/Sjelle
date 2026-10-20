# Sjelle build plan

## Milestone 0 — repository and delivery hygiene
- Establish monorepo folders, package manager, pinned dependencies and lockfile.
- Add formatting, lint, typecheck, unit-test and secret-scanning CI.
- Add `.env.example` with placeholders only; document Cloudflare deployment targets.
- Add threat model and architecture decision records.
**Exit gate:** clean install, CI green, no credentials in Git history.

## Milestone 1 — isolated backend foundation
- Create a dedicated Supabase development project and separate production project only when needed.
- Apply versioned migrations; seed six cities inactive.
- Add RLS policies, storage policies and authorization tests for customer/driver/merchant/admin.
- Generate TypeScript database types.
**Exit gate:** migration replay passes; cross-user/cross-merchant access tests fail closed.

## Milestone 2 — identity and operations
- Customer profile and address management.
- Driver application, private document uploads, expiry review and admin approval.
- Merchant onboarding, staff memberships and restaurant verification.
- Admin city/service controls and audit log.
**Exit gate:** unverified drivers and unapproved merchants cannot operate.

## Milestone 3 — food delivery
- Restaurant/menu discovery, cart, server-side checkout and cash order.
- Restaurant accept/reject/preparation workflow.
- Courier assignment after acceptance; pickup/delivery lifecycle and status notifications.
- Cash and merchant payable ledger.
**Exit gate:** one order can be completed end-to-end without duplicate records or manual DB edits.

## Milestone 4 — ride-hailing
- Routing adapter and fixed-route fare rules; estimates elsewhere.
- Ride quote, request, matching, driver arrival, trip start/completion.
- Driver location and customer tracking with reconnect handling.
- Cash, commission and driver payable accounting.
**Exit gate:** real test ride completes and reconciles correctly.

## Milestone 5 — shared driver app
- Mode switch, online/offline, offer expiry, accept/reject, navigation handoff and earnings.
- Prevent mode switch while busy and conflicting active jobs.
- Driver support and incident report.
**Exit gate:** concurrency tests show at most one incompatible active assignment.

## Milestone 6 — launch hardening
- Device E2E, load/rate-limit tests, abuse cases, backups and restore drill.
- Monitoring for API errors, stale GPS, delayed offers, failed notifications and ledger mismatch.
- Kosovo legal, licensing, tax, privacy, insurance and consumer readiness reviewed.
- Confirm map, push and online-payment providers; online payments remain disabled until approved.
**Exit gate:** all release acceptance tests pass and support/incident process is staffed.

## Milestone 7 — city-by-city pilot
- Start only in cities with enough verified drivers, restaurants and service coverage.
- Monitor quote-to-book, driver acceptance, pickup ETA, delivery duration, cancellations, support response and cash discrepancy.
- Expand to remaining seeded cities only after operational sign-off.

## Prioritized backlog
P0: auth/roles; city activation; driver verification; restaurant/menu; cash food order; restaurant acceptance; courier dispatch; ride quote/request; exclusive assignment; trip/order state machines; location privacy; ledger and reconciliation; support/admin/audit; RLS tests.
P1: ratings, promotions, scheduled rides, batching, online payments, merchant settlement export, advanced analytics, Serbian translations.
