# Sjelle production go-live checklist

Sjelle is deployed at https://fadiu007-creator.github.io/Sjelle/ and its API runs in the existing Supabase project `zikos`. This checklist separates software deployment from operational launch. Do not announce rides or food delivery as available until every launch gate below is verified.

## Current verified state

- Verified on **2026-11-19** against the live repository, GitHub Actions and the existing Supabase project `zikos` (`saavqlbwffrwxingbnri`). The current repository head is `d0c17c10f530d17ab3de03630ec57be24801d9a4`. API CI and the dedicated Sjelle API checks pass; the GitHub Pages build and deploy jobs pass. The latest browser-smoke job is still running at the time of this check.
- The Supabase Edge Function `sjelle-api` is active at **version 39** (updated 2026-11-19 09:11:48 UTC). Its deployed `index.ts` exactly matches the repository source, including the current paginated driver and restaurant review routes. A fresh public health request returned `ok: true`; the city endpoint returned all six configured cities.
- The live city configuration has **Ferizaj** active for rides and food. Gjilan, Mitrovica, Peja, Prishtina and Prizren remain inactive with both services disabled. There are six service-area records; only the Ferizaj area is active.
- Ferizaj has active estimated ride pricing version `ferizaj-mvp-v1`: base fare **€1.00**, minimum fare **€1.50**, distance **€0.60/km**, and time **€0.10/minute**. No active fixed-route price is configured, so eligible routes use the server-calculated estimate.
- Live supply snapshot: **6 driver profiles**, **1 approved profile**, **0 online drivers**, and **8 approved vehicle records**. The one approved driver profile currently has no latest identity, driving-licence, vehicle-registration or insurance documents; there are **0 evidence-ready approved drivers**. The server correctly keeps this driver from going online or receiving a job. Do not bypass this gate or create test documents.
- Food supply snapshot: **1 approved/open restaurant** and **1 available menu item**. Food ordering is configured in Ferizaj, but courier supply is still blocked by the absence of an evidence-ready online driver.
- Cash ledger snapshot: **0 completed cash rides** and **0 delivered cash orders**. The database currently reports **0 missing driver-cash collection entries**, but there have been no eligible completed cash jobs, so this is not an end-to-end cash-lifecycle test.
- Migration `20261119091250_sjelle_admin_review_queue_keyset_indexes` is applied to the existing project. It adds pending-only composite indexes for driver documents, vehicles, driver profiles and restaurant applications, matching the stable keyset pagination order. The repository contains the matching migration file.
- Admin review queues use bounded keyset pages; driver documents, vehicles, driver profiles and restaurant applications have independent cursors. The cash reconciliation page also uses keyset pagination with full-period totals.
- The live GitHub Pages homepage is reachable and serves the current Albanian customer experience. A fresh browser smoke run for the latest commit is still pending; do not treat its result as passed until the workflow completes.
- The admin portal's city controls still require explicit readiness confirmation for activation; deactivation remains available without that confirmation.
- Authenticated end-to-end ride and food-order lifecycle testing is still required. Do not announce public availability until a real driver completes identity/licence/registration/insurance verification, passes GPS readiness, goes online, and a controlled ride/delivery is completed and reconciled.

## 1. First administrator

The first admin role has been assigned to the confirmed `fatmirsejdiu007@gmail.com` account in the existing Supabase project. Next, sign in at https://fadiu007-creator.github.io/Sjelle/admin/ with a fresh session and verify that the dashboard loads live city, pricing and service-area data. If the session was already open when the role was granted, sign out and sign back in before testing. The city panel now includes a live configuration summary for city activation, active service-area geometry, active pricing and enabled services. This is a visibility aid only: driver/vehicle and restaurant/menu readiness must still pass the server-side activation checks.

The reusable `supabase/operations/first-admin.sql` bootstrap remains fail-closed and should only be used for another confirmed account after changing its placeholder. It touches only `public.sjelle_user_roles`.

## 2. Launch one city at a time

There are six city service-area records. Ferizaj has one active area; the other five are inactive draft references. They are simplified to fit the API's validation limits and are not a substitute for defining the actual dispatch/delivery coverage. Review each boundary, especially the Mitrovica city mapping, and replace it with the intended operational zone before activation.

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
