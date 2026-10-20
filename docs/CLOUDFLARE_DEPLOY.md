# Cloudflare deployment

Sjelle uses Cloudflare Workers with the static customer app in `apps/customer/`. The Worker API and customer assets deploy together from `apps/api/wrangler.toml`. No Vercel deployment is used.

## Required setup

1. Add GitHub Actions repository secrets:
   - `CLOUDFLARE_API_TOKEN` — a Cloudflare API token with permission to deploy Workers and manage Worker settings/assets for the target account.
   - `CLOUDFLARE_ACCOUNT_ID` — the Cloudflare account ID.
2. In Cloudflare Worker settings, configure both `sjelle-api-staging` and `sjelle-api-production` separately:
   - `SUPABASE_URL=https://saavqlbwffrwxingbnri.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY` as a secret
   - `ALLOWED_ORIGIN` to the exact public origin serving the customer app
3. Confirm the deployed Worker environment has the expected assets binding and test `/api/v1/health`, `/api/v1/ready`, and `/api/v1/cities`.

Never put the Supabase service-role key in GitHub source, a client bundle, or a non-secret Worker variable.

## Deploy

Open GitHub Actions → **Deploy Sjelle to Cloudflare** → **Run workflow**. Choose `staging` first. The workflow runs API tests and TypeScript type checking before deployment. Choose production only after staging is checked.

The workflow is manual by design; commits do not automatically deploy to a live Worker. Deployment has not been run from this repository yet.
