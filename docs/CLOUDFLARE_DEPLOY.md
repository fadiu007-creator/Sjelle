# Deployment from GitHub (recommended)

You can keep all code changes and the deployment button in GitHub. GitHub Actions deploys the Worker to Cloudflare; you do not need to install Wrangler or run terminal commands on your phone/computer.

## What GitHub-only hosting can and cannot do

GitHub Pages serves static files only. Sjelle's real ride/order APIs, authentication-aware operations, dispatch and scheduled recovery run on a Cloudflare Worker and use the existing Supabase project. Publishing `apps/customer/` alone to GitHub Pages will not deploy the API, and the current app uses root-relative paths and same-origin `/api/v1` calls. Do not treat a Pages build as a working production deployment.

Recommended arrangement: GitHub repository + GitHub Actions for deployment + Cloudflare Worker for app/API + existing Supabase `zikos` project. No Vercel and no new Supabase project.

## One-time setup

### 1. Create a Cloudflare API token

1. Sign in to the Cloudflare dashboard and open **My Profile → API Tokens**.
2. Choose **Create Token** and use a Workers deployment template if offered.
3. Scope it to the Cloudflare account that owns the Sjelle Worker. Grant only the permissions required to deploy Workers and Worker assets; do not use the Global API Key.
4. Copy the token once and keep it private.

### 2. Add two GitHub Actions secrets

1. Open `https://github.com/fadiu007-creator/Sjelle/settings/secrets/actions`.
2. Select **New repository secret**.
3. Add `CLOUDFLARE_API_TOKEN` with the token from step 1.
4. Add `CLOUDFLARE_ACCOUNT_ID` with the Account ID shown on the Cloudflare account overview.
5. Never add the Supabase service-role key to source code, GitHub Pages variables, or browser-visible settings.

### 3. Configure the Cloudflare Worker bindings

In Cloudflare, open **Workers & Pages**. Configure both Worker environments, `sjelle-api-staging` and `sjelle-api-production`, separately. In each environment's **Settings → Variables and Secrets**, add:

- `SUPABASE_URL` — `https://saavqlbwffrwxingbnri.supabase.co`
- `SUPABASE_PUBLISHABLE_KEY` — regular variable; use the publishable key from the existing `zikos` project
- `SUPABASE_SERVICE_ROLE_KEY` — **secret**; use the service-role key from the existing `zikos` project
- `ALLOWED_ORIGIN` — exact origin of the Worker website, e.g. `https://sjelle-api-staging.<your-subdomain>.workers.dev` for staging; use the production Worker origin in production
- `ROUTING_API_URL` — URL of a real OSRM-compatible routing service
- `GEOCODING_API_URL` — URL of a real Nominatim-compatible geocoder

If the chosen routing/geocoding provider requires API keys, add `ROUTING_API_KEY` and/or `GEOCODING_API_KEY` as **secrets**. Do not use public demo endpoints for production traffic. Save settings for each environment. Keep `SUPABASE_SERVICE_ROLE_KEY` secret and server-side only.

If you do not yet have a reliable routing/geocoding provider, do not activate rides publicly; the readiness check is expected to fail until these integrations are configured.

## Deploy through GitHub Actions

1. Open the repository's **Actions** tab: `https://github.com/fadiu007-creator/Sjelle/actions`.
2. Choose **Deploy Sjelle to Cloudflare** from the workflow list.
3. Press **Run workflow**.
4. Select `staging` first.
5. In `worker_url`, enter the exact HTTPS URL of the staging Worker, without a trailing slash. Use the URL shown for `sjelle-api-staging` in Cloudflare; do not guess it.
6. Start the workflow and open its run to follow each step. It runs API tests and TypeScript checks, checks portal JavaScript syntax, performs a Wrangler dry run, deploys, then probes the homepage, portals, health, cities and readiness endpoints.
7. If a step fails, open the failed step's log. Fix missing secrets/bindings or code errors, commit the fix to `main`, then run the workflow again.
8. Test staging: create a test customer, verify sign-in, check city availability, and test customer/driver/merchant/admin flows with controlled test accounts. Keep all launch cities disabled during testing.
9. Only after staging checks pass, run the same workflow with `production` and the exact production Worker URL.

## How to interpret the result

- **Green workflow:** the deploy command succeeded and the configured smoke checks passed. It is stronger than a Pages build, but still does not prove every ride/order journey or operational process works.
- **Failed at missing Cloudflare secrets:** complete step 2.
- **Failed at readiness:** inspect Worker bindings and provider configuration in step 3.
- **Failed at homepage/portal checks:** inspect the deployment log and verify the Worker URL and asset deployment.
- **Failed routing/geocoding checks:** configure supported providers and test them in staging; do not bypass the readiness check just to force deployment.

## Important launch gates

Keep all six candidate cities inactive until pricing, real service-area polygons, drivers, restaurants, menus, support coverage and local compliance have been reviewed. Current payment support is cash only; do not advertise card payments. Deployment success alone is not permission to start accepting public bookings.

## Current status

The deployment workflow is manual by design. A successful GitHub Pages workflow does not deploy the API. Run **Deploy Sjelle to Cloudflare** as described above to publish the complete app.