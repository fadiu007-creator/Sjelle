# Sjelle

Sjelle is a Kosovo-first ride-hailing and food-delivery platform. One customer app supports rides and restaurant orders; drivers use one app with separate Ride and Delivery modes. The initial target cities are Prishtina, Ferizaj, Prizren, Gjilan, Mitrovica, and Peja.

## Product decisions

- **Brand:** Sjelle
- **Launch market:** six candidate cities in Kosovo, activated city-by-city only after supply, support, coverage, and compliance checks
- **Services:** ride-hailing and restaurant food delivery
- **Driver model:** shared driver app; a driver cannot switch modes while an incompatible job is active
- **Ride pricing:** fixed prices for configured popular routes; server-calculated estimates elsewhere
- **Payments:** cash for rides and food initially; online payments only after a supported Kosovo provider and reconciliation flow are verified
- **Food dispatch:** platform assigns a courier after restaurant acceptance, using preparation time to reduce waiting
- **Driver onboarding:** identity, driving licence, vehicle documents, expiry and eligibility verified by an authorized administrator before activation
- **Hosting:** Cloudflare Pages/Workers
- **Backend:** existing Supabase project `zikos` (`saavqlbwffrwxingbnri`), with every Sjelle database object namespaced `sjelle_` to avoid collisions
- **No Vercel**

## Repository structure

- `docs/IMPLEMENTATION_SPEC.md` — scope, roles, stories, workflows, security, acceptance criteria and roadmap
- `docs/API_CONTRACTS.md` — proposed API contracts and status models
- `supabase/migrations/` — versioned PostgreSQL schema migrations
- `apps/customer/` — customer mobile app (planned)
- `apps/driver/` — driver mobile app (planned)
- `apps/merchant-web/` — merchant portal (planned)
- `apps/admin-web/` — operations dashboard (planned)
- `apps/api/` — Cloudflare Worker API (planned)

## Development principles

1. Build and verify in a development Supabase project before production.
2. Never connect Sjelle to the existing `zikos` project or mutate unrelated applications.
3. Never expose Supabase service-role keys or other secrets in browser/mobile bundles.
4. Server-side logic is authoritative for pricing, role checks, dispatch, job state and financial records.
5. Use integer euro cents, immutable ledger entries, idempotency keys and auditable administrative actions.
6. Do not use fake driver GPS, fake payments, or demo success states in production paths.
7. No city is considered live until licensing, operating coverage, support, and driver/merchant supply are verified.

## Current status

This repository starts with the product blueprint and database design. No Supabase project, Cloudflare deployment, payment provider, or production service has been provisioned by this commit.

## Next steps

See [implementation specification](docs/IMPLEMENTATION_SPEC.md), [API contracts](docs/API_CONTRACTS.md), and [database migration](supabase/migrations/202610200001_initial_schema.sql).