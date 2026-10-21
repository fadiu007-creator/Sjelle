# Cloudflare deployment

Sjelle uses Cloudflare Workers with the static customer app in `apps/customer/`. The Worker API and customer assets deploy together from `apps/api/wrangler.toml`. No Vercel deployment is used.

## Required setup

1. Add GitHub Actions repository secrets:
   - `CLOUDFLARE_API_TOKEN` — a Cloudflare API token with permission to deploy Workers and manage Worker settings/assets for the target account.
   - `CLOUDFLARE_ACCOUNT_ID` — the Cloudflare account ID.
2. In Cloudflare Worker settings, configure both `sjelle-api-staging` and `sjelle-api-production` separately:
   - `SUPABASE_URL=https://saavqlbwffrwxingbnri.supabase.co`
   - `SUPABASE_PUBLISHABLE_KEY` as a Worker variable
   - `SUPABASE_SERVICE_ROLE_KEY` as a secret
   - `ALLOWED_ORIGIN` to the exact public origin serving the customer app
   - `ROUTING_API_URL` to an OSRM-compatible routing service base URL (required for address-based quotes)
   - `ROUTING_API_KEY` as a secret if your routing provider requires a bearer token
   - `GEOCODING_API_URL` to a Nominatim-compatible geocoding service base URL (required for address search)
   - `GEOCODING_API_KEY` as a secret if your geocoder requires a bearer token
3. Confirm the deployed Worker environment has the expected assets binding and test `/api/v1/health`, `/api/v1/ready`, and `/api/v1/cities`.

Never put the Supabase service-role key in GitHub source, a client bundle, or a non-secret Worker variable.

## Deploy

Open GitHub Actions → **Deploy Sjelle to Cloudflare** → **Run workflow**. Choose `staging` first and provide the exact HTTPS URL for that Worker (without a trailing slash). The workflow runs API tests and TypeScript type checking before deployment, then checks `/api/v1/health` and `/api/v1/ready`. Readiness must confirm database connectivity. Choose production only after staging is checked.

The readiness endpoint now requires the Supabase URL/service-role key, publishable key, allowed customer origin, routing URL and geocoding URL, then confirms database connectivity. Provider API keys are only required when the chosen provider needs them. The workflow is manual by design; commits do not automatically deploy to a live Worker. Deployment has not been run from this repository yet.
