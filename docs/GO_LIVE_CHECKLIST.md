# Sjelle production go-live checklist

Sjelle is deployed at https://fadiu007-creator.github.io/Sjelle/ and its API runs in the existing Supabase project `zikos`. This checklist separates software deployment from operational launch. Do not announce rides or food delivery as available until every launch gate below is verified.

## Current verified state

- The static site is published at GitHub Pages and the Supabase Edge Function `sjelle-api` is active at version 17. API CI and the custom Pages workflow are configured, but CI status for the latest code commits is not confirmed; do not mark the latest tests as passing until GitHub reports success.
- `fatmirsejdiu007@gmail.com` is a confirmed Supabase Auth account and now has the `admin` role in `public.sjelle_user_roles`. Sign in to the admin portal and verify access with a fresh session.
- All six candidate cities (Prishtina, Ferizaj, Prizren, Gjilan, Mitrovica and Peja) remain disabled for rides and food delivery.
- Six **inactive draft reference boundaries** have been added for the six candidate cities from the public GeoJSON-Kosova municipality dataset. They are simplified reference polygons, not approved operational coverage. The source includes OSM-derived geoBoundaries data: https://github.com/Learti82/GeoJSON-Kosova. Review each boundary in the admin portal, especially the Mitrovica city mapping, and replace it with the intended operational zone before activation.
- Live database audit (2026-10-22): one driver profile exists but none are approved; there are zero vehicles, restaurants, menu items, and active fixed routes. All six cities have zero active service areas and zero active city-pricing versions. Keep all services disabled until real coverage, pricing and supply are configured.
- Live authenticated end-to-end ride and food-order lifecycle testing is still required; public service must remain disabled until supply and operating gates are met.

## 1. First administrator

The first admin role has been assigned to the confirmed `fatmirsejdiu007@gmail.com` account in the existing Supabase project. Next, sign in at https://fadiu007-creator.github.io/Sjelle/admin/ with a fresh session and verify that the dashboard loads live city, pricing and service-area data. If the session was already open when the role was granted, sign out and sign back in before testing.

The reusable `supabase/operations/first-admin.sql` bootstrap remains fail-closed and should only be used for another confirmed account after changing its placeholder. It touches only `public.sjelle_user_roles`.

## 2. Launch one city at a time

The six municipality polygons currently stored in `sjelle_service_areas` are inactive draft references. They are simplified to fit the API's validation limits and are not a substitute for defining the actual dispatch/delivery coverage. The source municipality for the `mitrovica` slug is currently South Mitrovica; confirm that this is the intended scope. Do not activate a draft area until an operator has reviewed it and agreed to the actual service boundary.

For a city to offer rides:
- Confirm local legal/licensing, insurance, driver eligibility, support and cash-handling requirements.
- Create and validate the real service-area polygon and activate it only after review.
- Configure and review a pricing version.
- Add real fixed routes where applicable and verify route endpoints/coordinates.
- Recruit real drivers, collect the required identity, licence, registration and insurance documents, approve each document, verify the vehicle, and test driver online/offline and location updates.
- Test quote → booking → dispatch → driver acceptance → pickup → completion/cancellation → cash reconciliation with authorized test accounts.

For a city to offer food delivery:
- Recruit real restaurants and verify owner contact, address and coordinates.
- Approve restaurant applications.
- Have each restaurant enter accurate menu items, prices, availability and preparation estimates.
- Test menu availability → order creation → restaurant accept/reject → preparation → courier assignment → delivery completion/cancellation → cash reconciliation.

The API blocks city activation if the required service area, active pricing, ready menu/restaurant supply or approved driver/route supply is missing. Do not bypass these checks.

## 3. Production checks before taking public orders

- Confirm the GitHub Pages source is set to **GitHub Actions** in repository Settings → Pages; the custom deployment workflow is the intended publisher.
- Confirm Supabase Edge Function secrets are set only in Supabase: project URL, publishable key, service-role key and exact allowed GitHub Pages origin. Never put the service-role key in frontend code.
- Verify email confirmation, login, logout, expired sessions, and account recovery.
- Test customer, driver, merchant and admin access separately with dedicated accounts.
- Run an end-to-end test ride and food order in a non-publicly enabled city or controlled test setup; check idempotency, duplicate requests, cancellations, state transitions and immutable cash ledger entries.
- Verify support ticket handling, emergency/escalation ownership, privacy notice, terms, refund/cancellation policy and data retention before public launch.
- Confirm the routing and geocoding providers are reliable under expected load and review their terms/rate limits.
- Do not advertise online payments; cash is the configured initial payment approach.
- Keep all unready cities and services disabled. Enable one service in one city only after the operator signs off on the checklist and tests.

## 4. What is not included yet

- Native iOS/Android driver apps, push notifications and online payment integration.
- Completed authenticated end-to-end lifecycle tests with real operational accounts and supply.
- Legal, insurance, tax, customer support and local business/driver onboarding sign-off; these require the operator, not code alone.
