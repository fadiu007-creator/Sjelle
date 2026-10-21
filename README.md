# Sjelle

Sjelle is a Kosovo-first ride-hailing and food-delivery platform. One customer experience will support rides and restaurant orders; drivers will use a shared app with separate Ride and Delivery modes. Launch cities: Prishtina, Ferizaj, Prizren, Gjilan, Mitrovica and Peja.

## Product decisions

- **Brand:** Sjelle
- **Launch market:** six candidate cities in Kosovo, activated one by one after supply, coverage, support and compliance checks
- **Services:** ride-hailing and restaurant food delivery
- **Ride pricing:** fixed prices for configured popular routes; server-calculated estimates elsewhere
- **Payments:** cash initially; online payments only after a supported provider and reconciliation flow are verified
- **Food dispatch:** courier assignment begins after restaurant acceptance
- **Driver onboarding:** identity, driving licence and vehicle documents verified before activation
- **Hosting:** GitHub Pages for the static web portals; existing Cloudflare setup deferred until the owner chooses to configure it
- **Backend:** existing Supabase project `zikos` (`saavqlbwffrwxingbnri`), using additive `sjelle_*` database objects and a Supabase Edge Function API to protect unrelated apps
- **No Vercel**

## Repository structure

- `docs/IMPLEMENTATION_SPEC.md` — scope, roles, workflows, security and acceptance criteria
- `docs/API_CONTRACTS.md` — planned API contracts and status models
- `docs/DRIVER_OPERATIONS.md` — driver status/cash controls and pre-launch verification checklist
- `supabase/migrations/` — versioned schema migrations, aligned to applied Supabase migration history
- `apps/customer/` — static customer web app and customer, driver, merchant and admin portals served from GitHub Pages
- `apps/api/` — API source, domain tests and compatibility checks
- `supabase/functions/sjelle-api/` — deployed Supabase Edge Function API runtime and pricing module
- `apps/customer/driver/` — driver portal (native mobile app still planned)
- `apps/customer/merchant/` — restaurant onboarding, menu and order portal
- `apps/customer/admin/` — operations dashboard

## Current implementation

- Applied 27 namespaced Sjelle tables to `zikos`; RLS is enabled on all 27.
- Added least-privilege client grants and indexes for foreign-key relationships. No existing app tables were targeted.
- Seeded the six candidate cities as inactive with rides and food delivery disabled.
- Supabase Edge Function endpoints include health/readiness, city/restaurant/menu discovery, authentication/profile, food ordering, ride quoting/booking/cancellation, merchant order/menu management, driver onboarding/document review/dispatch and admin pricing, GeoJSON service areas, route/city activation.
- Customer, driver, merchant and admin portals are present under `apps/customer/`, backed by real API calls. No portal fakes booking, payment or approval success.
- Customer support now includes ticket submission and personal ticket history; admins have an authenticated support queue with status updates, self-assignment and audit records. API CI and the static Pages workflow are configured; the latest commit's CI result is not confirmed.
- Server-calculated ride quotes use a configured OSRM-compatible routing provider; address search uses a configured Nominatim-compatible geocoder. Supabase `pg_cron` runs `sjelle_dispatch_waiting_jobs()` once per minute to recover waiting dispatches.
- API CI runs tests and TypeScript checks on API/migration changes. The GitHub Pages workflow tests the API source, smoke-tests the live Supabase API, validates portal assets, deploys the static site and runs real-browser smoke tests for all four portals. Online payments, push notifications, native mobile apps and authenticated end-to-end lifecycle tests remain outstanding.

## Security and operating principles

1. Keep every Sjelle database object namespaced; do not run broad schema/grant changes or destructive resets in the shared project.
2. Never expose Supabase service-role keys in browser/mobile bundles or commit real secrets.
3. Server-side logic must be authoritative for pricing, role checks, dispatch, job state and financial records.
4. Use integer euro cents, idempotency keys, immutable ledger entries and auditable administrative actions.
5. Do not use fake driver GPS, fake payments or fake success states.
6. Do not activate a city until licensing, operating coverage, support and driver/merchant supply are verified.

## Deployment

The static portals are hosted at [Sjelle on GitHub Pages](https://fadiu007-creator.github.io/Sjelle/). API requests are handled by the existing Supabase Edge Function at `https://saavqlbwffrwxingbnri.supabase.co/functions/v1/sjelle-api/api/v1`. Cloudflare is intentionally deferred until requested. See [the GitHub Pages deployment workflow](.github/workflows/deploy-github-pages.yml).

## Local API development

From `apps/api`, use Node.js 22:

```sh
npm install
cp .dev.vars.example .dev.vars
# Add the real SUPABASE_SERVICE_ROLE_KEY to .dev.vars locally only.
npm test
npm run typecheck
npm run dev
```

The deployed Supabase Edge Function uses its configured secrets for `SUPABASE_URL`, the publishable/anonymous key, `SUPABASE_SERVICE_ROLE_KEY` and `ALLOWED_ORIGIN`. No service-role key is committed or exposed to the frontend.

## Key files

- [Implementation specification](docs/IMPLEMENTATION_SPEC.md)
- [API contracts](docs/API_CONTRACTS.md)
- [Production go-live checklist](docs/GO_LIVE_CHECKLIST.md)
- [Safe first-admin bootstrap SQL](supabase/operations/first-admin.sql) — run manually after replacing the confirmed account email
- [Initial schema](supabase/migrations/20261020203959_sjelle_initial_namespaced_schema.sql)
- [Least-privilege grants](supabase/migrations/20261020204056_sjelle_least_privilege_grants.sql)
