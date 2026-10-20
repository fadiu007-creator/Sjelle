# Sjelle API

Cloudflare Worker API backed by the existing Supabase project `zikos`. Every Sjelle database object uses the `sjelle_*` namespace. Never run broad schema/grant changes against unrelated apps.

## Implemented endpoint groups

- **Health/config:** `GET /api/v1/health`, `GET /api/v1/ready`.
- **Public discovery:** `GET /api/v1/cities`, `GET /api/v1/restaurants?city=<slug>`, `GET /api/v1/restaurants/:slug/menu`.
- **Authentication/profile:** `POST /api/v1/auth/signup`, `POST /api/v1/auth/login`, `POST /api/v1/auth/refresh`, `POST /api/v1/auth/logout`, `GET /api/v1/me`, `PUT /api/v1/me`.
- **Ride requests:** `POST /api/v1/geocode`, `POST /api/v1/ride-quotes`, `POST /api/v1/rides`, `GET /api/v1/rides`, `POST /api/v1/rides/:id/cancel`. A ride can be booked against an active fixed route via `x-route-id`, or against a server-created quote via `quote_id`. Both require `Idempotency-Key`.
- **Food ordering:** `POST /api/v1/food-orders`, `GET /api/v1/food-orders`, `GET /api/v1/food-orders/:id`, `POST /api/v1/food-orders/:id/cancel`.
- **Merchant portal:** `GET/POST /api/v1/merchant/restaurants`, `PATCH /api/v1/merchant/restaurants/:id/settings`, `POST /api/v1/merchant/restaurants/:id/categories`, `POST /api/v1/merchant/restaurants/:id/menu-items`, `PATCH /api/v1/merchant/menu-items/:id`, `GET /api/v1/merchant/orders`, `PATCH /api/v1/merchant/orders/:id/status`.
- **Driver portal:** `POST /api/v1/driver/apply`, `GET /api/v1/driver/me`, `POST /api/v1/driver/vehicles`, `POST /api/v1/driver/documents`, `PATCH /api/v1/driver/availability`, `POST /api/v1/driver/location`, `GET /api/v1/driver/offers`, `POST /api/v1/driver/offers/:id/respond`, `GET /api/v1/driver/jobs`, `POST /api/v1/driver/jobs/:kind/:id/status`.
- **Admin portal:** city/pricing configuration, fixed route creation/activation, guarded city activation, restaurant review, driver-document and vehicle review, driver approval, signed document URLs, and dispatch retry. All require a database-backed Sjelle admin role.

Unknown routes return 404. The Worker does not fake successful bookings, orders, payments or approvals.

## Local setup

1. Use Node.js 22.
2. Run `npm install`.
3. Copy `.dev.vars.example` to `.dev.vars`.
4. Add the real Supabase service-role key to `.dev.vars` locally; never commit it or put it in the client app.
5. Run `npm test` and `npm run typecheck`.
6. Run `npm run dev`.

For Cloudflare, configure `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and `ALLOWED_ORIGIN` per environment. Address search requires a Nominatim-compatible `GEOCODING_API_URL`; accurate ride distance/time and estimates require an OSRM-compatible `ROUTING_API_URL`. Configure provider keys as secrets when required. Do not rely on public demo routing services for live traffic.

The Worker scheduled handler calls `sjelle_dispatch_waiting_jobs` once per minute. Driver offers expire after 45 seconds and the recovery job retries waiting jobs against newly eligible drivers.

## Security boundaries

- Supabase Auth validates bearer tokens; missing/invalid tokens receive 401.
- The service-role key is used only inside the Worker, never in web/mobile bundles.
- Direct client access to sensitive Sjelle tables is restricted; driver documents use a private storage bucket and five-minute signed URLs for authorized admins.
- User IDs and roles are derived/validated server-side; the client cannot choose a role or submit a fare.
- Fare calculation, quote expiry, idempotency, state transitions and dispatch decisions are server-authoritative.
- Cities remain inactive until explicitly configured and activated by an admin.
- Payments are cash-only. Online payments, refunds, settlement and cash reconciliation are not implemented.
