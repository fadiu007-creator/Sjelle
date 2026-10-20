# Sjelle API

Cloudflare Worker API foundation.

## Current implemented scope
- `GET /api/v1/health` returns service health and a request ID.
- CORS preflight handling with an explicit `ALLOWED_ORIGIN` binding.
- Pure ride fare calculation for active fixed-route rules and estimate fallback.
- Pure ride and food-order transition guards.
- Unit tests for fare precedence, minimum fare, input validation and invalid state jumps.

Business endpoints, authentication middleware, database access, routing provider integration and dispatch transactions are **not implemented yet**. Unknown endpoints return 404; they do not simulate successful operations.

## Local setup
1. Install Node.js 22.
2. Run `npm install`.
3. Copy `.dev.vars.example` to `.dev.vars` and set local values when a development project exists.
4. Run `npm test`.
5. Run `npm run typecheck`.
6. Run `npm run dev`.

Do not add service-role keys to mobile/web client code or commit `.dev.vars`. Before enabling database-backed endpoints, add verified JWT handling, role/relationship authorization, idempotency, structured logging and RLS integration tests.
