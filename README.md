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
- **Hosting:** Cloudflare Workers with static customer assets
- **Backend:** existing Supabase project `zikos` (`saavqlbwffrwxingbnri`), using additive `sjelle_*` database objects to protect unrelated apps
- **No Vercel**

## Repository structure

- `docs/IMPLEMENTATION_SPEC.md` — scope, roles, workflows, security and acceptance criteria
- `docs/API_CONTRACTS.md` — planned API contracts and status models
- `docs/DRIVER_OPERATIONS.md` — driver status/cash controls and pre-launch verification checklist
- `supabase/migrations/` — versioned schema migrations, aligned to applied Supabase migration history
- `apps/customer/` — mobile-first customer web app served as Cloudflare Worker static assets
- `apps/api/` — Cloudflare Worker API, tests and deployment configuration
- `apps/customer/driver/` — driver portal (native mobile app still planned)
- `apps/customer/merchant/` — restaurant onboarding, menu and order portal
- `apps/customer/admin/` — operations dashboard

## Current implementation

- Applied 27 namespaced Sjelle tables to `zikos`; RLS is enabled on all 27.
- Added least-privilege client grants and indexes for foreign-key relationships. No existing app tables were targeted.
- Seeded the six candidate cities as inactive with rides and food delivery disabled.
- Cloudflare Worker endpoints include health/readiness, city/restaurant/menu discovery, authentication/profile, food ordering, ride quoting/booking/cancellation, merchant order/menu management, driver onboarding/document review/dispatch and admin pricing, GeoJSON service areas, route/city activation.
- Customer, driver, merchant and admin portals are present under `apps/customer/`, backed by real API calls. No portal fakes booking, payment or approval success.
- Customer support now includes ticket submission and personal ticket history; admins have an authenticated support queue with status updates, self-assignment and audit records. Latest API CI and static Pages build workflow checks pass for the current commit.
- Server-calculated ride quotes use a configured OSRM-compatible routing provider; address search uses a configured Nominatim-compatible geocoder. A one-minute Cloudflare cron retries dispatch for waiting jobs.
- API CI runs tests and TypeScript checks on API/migration changes. The manual Cloudflare deployment workflow additionally checks customer/portal JavaScript syntax and runs a Wrangler dry-run before deployment. The latest API CI, API checks, and repository Pages build workflow runs passed for the current source revision. These are source/build checks, not proof that the Cloudflare Worker was deployed. Online payments, push notifications, native mobile apps and live Cloudflare deployment are still outstanding.

## Security and operating principles

1. Keep every Sjelle database object namespaced; do not run broad schema/grant changes or destructive resets in the shared project.
2. Never expose Supabase service-role keys in browser/mobile bundles or commit real secrets.
3. Server-side logic must be authoritative for pricing, role checks, dispatch, job state and financial records.
4. Use integer euro cents, idempotency keys, immutable ledger entries and auditable administrative actions.
5. Do not use fake driver GPS, fake payments or fake success states.
6. Do not activate a city until licensing, operating coverage, support and driver/merchant supply are verified.

## Deployment

See [Cloudflare deployment instructions](docs/CLOUDFLARE_DEPLOY.md) and [operations bootstrap](docs/OPERATIONS_BOOTSTRAP.md). Deployment is manual and has not yet been run from this repository.

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

Cloudflare requires the `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY` and `ALLOWED_ORIGIN` bindings/secrets to be configured per environment before database-backed endpoints work. The URL is the existing `zikos` project. No secret is committed.

## Key files

- [Implementation specification](docs/IMPLEMENTATION_SPEC.md)
- [API contracts](docs/API_CONTRACTS.md)
- [Initial schema](supabase/migrations/20261020203959_sjelle_initial_namespaced_schema.sql)
- [Least-privilege grants](supabase/migrations/20261020204056_sjelle_least_privilege_grants.sql)
