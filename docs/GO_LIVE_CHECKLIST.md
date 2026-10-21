# Sjelle production go-live checklist

Sjelle is deployed at https://fadiu007-creator.github.io/Sjelle/ and its API runs in the existing Supabase project `zikos`. This checklist separates software deployment from operational launch. Do not announce rides or food delivery as available until every launch gate below is verified.

## Current verified state

- The latest GitHub Actions deployment completed successfully, including the browser smoke test for the homepage, driver, merchant and admin portals.
- The API CI and live API deployment smoke checks passed.
- Six candidate cities exist, but all remain disabled.
- The Sjelle operational tables currently have no driver profiles, vehicles, restaurants, menus, fixed routes, service areas or admin roles.
- The static pages and API are deployed; live authenticated end-to-end ride and food-order lifecycle testing is still required.

## 1. Create the first administrator safely

1. Open the public Sjelle site and create an account using an email you control.
2. Confirm that account through Supabase Auth.
3. In Supabase Dashboard, select the existing project `zikos` (ref `saavqlbwffrwxingbnri`) and open **SQL Editor**.
4. Open `supabase/operations/first-admin.sql` in this repository. Replace the placeholder with the exact confirmed account email, then run it manually.
5. Verify that the expected email has the `admin` role in `public.sjelle_user_roles`. Do not grant the role to unrelated users in the shared Supabase project.
6. Sign in to https://fadiu007-creator.github.io/Sjelle/admin/ and verify the admin dashboard loads data from the live API.

The bootstrap SQL fails closed if the placeholder is unchanged or the email is not a confirmed Auth account. It does not modify roles or tables belonging to other applications.

## 2. Launch one city at a time

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
