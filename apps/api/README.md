# Sjelle API

Cloudflare Worker API backed by the existing Supabase project `zikos`. Sjelle tables are namespaced `sjelle_*`; never run broad schema/grant changes against unrelated apps.

## Implemented endpoints

- `GET /api/v1/health` — liveness response and request ID; does not require the database.
- `GET /api/v1/ready` — checks that the configured Supabase REST endpoint can read Sjelle's city table.
- `GET /api/v1/cities` — returns the six configured cities and their service-enabled/active flags from the database. Inactive cities are shown as planned, not bookable.
- `GET /api/v1/restaurants?city=<slug>` — lists approved, open, delivery-enabled restaurants only when that city is active for food delivery.
- `GET /api/v1/restaurants/:slug/menu` — returns public restaurant details, active menu categories, and available menu items only for an approved/open restaurant in an active food city.
- `GET /api/v1/me` — verifies the bearer token through Supabase Auth and returns only the caller's Sjelle profile.
- `PUT /api/v1/me` — validates and saves the caller's profile and assigns only the `customer` role if missing. The caller cannot supply a user ID or choose a role.

Unknown routes return 404; unavailable backend/configuration returns 503. No ride booking, food order placement, pricing quote, payment, or dispatch endpoint is exposed until the routing, idempotency and transactional rules are implemented.

## Local setup

1. Use Node.js 22.
2. Run `npm install`.
3. Copy `.dev.vars.example` to `.dev.vars`.
4. Add the real Supabase service-role key to `.dev.vars` locally; never commit it or put it in the client app.
5. Run `npm test`.
6. Run `npm run typecheck`.
7. Run `npm run dev`.

For Cloudflare, configure `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `ALLOWED_ORIGIN` as environment-specific Worker bindings/secrets. The service-role key must remain server-side. The Worker only selects explicit public city/profile columns and derives identity from the verified Supabase user, never from a client-supplied user ID.

## Security boundaries

- Supabase Auth validates bearer tokens; missing/invalid tokens receive 401.
- The service-role key is used only inside the Worker, not mobile/web clients.
- Direct client privileges on Sjelle tables are explicitly allowlisted in migration `202610200003_sjelle_least_privilege_grants.sql`.
- Customer role assignment is hard-coded server-side; driver, merchant, support and admin roles require a separate reviewed workflow.
- Ride and food state machines and fare calculation are pure domain functions with unit tests.
