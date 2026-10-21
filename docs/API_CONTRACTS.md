# Sjelle API contracts (v1 proposal)

Base path: `/api/v1`. JSON request/response. Authenticated requests use Supabase access JWT. Mutating requests accept `Idempotency-Key`; API derives user identity from verified JWT, never from request body. Errors use `{ "error": { "code": "...", "message": "...", "request_id": "..." } }`.

## Shared conventions
- Currency amounts are integer EUR cents; lat/lon are WGS84 decimal degrees.
- Server owns role checks, pricing, assignment, status transitions and financial effects.
- Use UTC ISO-8601 timestamps; clients display local time.
- Pagination uses opaque cursor tokens. Never expose private document storage keys.
- Common errors: 400 VALIDATION_ERROR, 401 UNAUTHENTICATED, 403 FORBIDDEN, 404 NOT_FOUND, 409 STATE_CONFLICT, 409 IDEMPOTENCY_CONFLICT, 422 OUTSIDE_SERVICE_AREA, 429 RATE_LIMITED, 500 INTERNAL_ERROR.

## Customer and profile
- `GET /me` — own profile and authorized roles.
- `PATCH /me` — update permitted profile fields; role/status cannot be changed.
- `GET /cities?active=true` — active city and service availability.
- `GET /addresses`, `POST /addresses`, `PATCH /addresses/{id}`, `DELETE /addresses/{id}` — own saved addresses.

## Rides
- `POST /rides/quote`
  Request: `{ "city_id":"uuid", "pickup":{"lat":42.66,"lon":21.16,"label":"..."}, "destination":{"lat":42.64,"lon":21.15,"label":"..."}, "vehicle_type":"standard" }`
  Response: `{ "quote_id":"uuid", "pricing_kind":"fixed_route|estimated", "amount_cents":650, "currency":"EUR", "distance_m":4200, "duration_s":780, "expires_at":"...", "pricing_version":"..." }`
- `POST /rides`
  Request: `{ "quote_id":"uuid", "payment_method":"cash", "idempotency_key":"..." }`
  Response 201: `{ "ride_id":"uuid", "status":"searching", "amount_cents":650 }`
- `GET /rides/{id}` — customer or assigned driver; location fields scoped to active trip.
- `POST /rides/{id}/cancel` — body includes reason code; server calculates any disclosed cancellation fee.
- `POST /rides/{id}/driver-arrived`, `/start`, `/complete` — assigned driver only, valid-state transitions only.
- `GET /rides/{id}/events` — authorized trip history.

## Food
- `GET /restaurants?city_id=&lat=&lon=&category=&cursor=` — approved, open, in-coverage restaurants.
- `GET /restaurants/{id}` and `GET /restaurants/{id}/menu` — currently available menu and server prices.
- `POST /food/orders`
  Request: `{ "restaurant_id":"uuid", "city_id":"uuid", "delivery_address_id":"uuid", "items":[{"menu_item_id":"uuid","quantity":2,"option_ids":["uuid"]}], "instructions":"...", "payment_method":"cash" }`
  Response 201: `{ "order_id":"uuid", "status":"submitted", "item_subtotal_cents":1200, "delivery_fee_cents":150, "service_fee_cents":0, "total_cents":1350, "currency":"EUR" }`
  Server validates menu and address and snapshots prices; client totals are ignored.
- `GET /food/orders/{id}` — customer, restaurant staff and assigned courier with field-level restrictions.
- `POST /food/orders/{id}/accept` — restaurant staff; body `{ "prep_time_minutes":20 }`.
- `POST /food/orders/{id}/reject` — restaurant staff; reason code required.
- `POST /food/orders/{id}/ready` — restaurant staff.
- `POST /food/orders/{id}/cancel` — permitted actor/reason; refund/cash handling determined server-side.
- `POST /delivery-jobs/{id}/pickup`, `/deliver` — assigned courier only; optional proof reference must be private and authorized.

## Driver
- `POST /driver/applications` — submit onboarding details; no self-approval.
- `POST /driver/documents/upload-url` — authorized driver gets short-lived signed upload URL; file type/size verified.
- `GET /driver/me/status` — approval, expiry and readiness checklist.
- `POST /driver/availability` — `{ "online":true, "mode":"ride|delivery", "city_id":"uuid" }`; rejected if not approved or job active.
- `POST /driver/location` — `{ "lat":42.66,"lon":21.16,"accuracy_m":12,"heading":180,"recorded_at":"..." }`; rate-limited, freshness/accuracy checked.
- `GET /driver/offers` — current offers for selected mode.
- `POST /driver/offers/{id}/accept`, `/reject` — accept is transactional and may return 409 if expired or already claimed.
- `GET /driver/jobs/active`, `GET /driver/earnings?from=&to=`.

## Finance and reconciliation
- GET /admin/reconciliation?from=YYYY-MM-DD&to=YYYY-MM-DD — admin-only read of up to 1,000 ledger entries in the inclusive UTC date range, with signed net totals grouped by account type. Defaults to the latest 30 calendar days; rejects invalid dates, reversed ranges, and inclusive ranges longer than 366 days. Totals fail closed for malformed amounts, non-EUR entries, or integer overflow. Response marks possibly_truncated when the 1,000-row limit is reached, so this endpoint must not be treated as a complete export when truncated.
- Cash collection ledger postings are created by database triggers when a cash ride is completed and marked collected or a cash delivery is delivered and marked collected. A deterministic unique idempotency key prevents duplicate customer-due/driver-collected entries. This is not yet a full commission, merchant settlement, cash handover, or dispute workflow.

## Merchant and admin
- `GET /merchant/restaurants` — only assigned restaurants.
- `PATCH /merchant/restaurants/{id}/hours`, `PATCH /merchant/menu-items/{id}` — staff with appropriate permissions.
- `GET /merchant/orders?status=&cursor=` — only restaurant's orders.
- `GET /admin/cities`, `POST /admin/cities/{id}/activate`, `POST /admin/cities/{id}/deactivate`.
- `POST /admin/drivers/{id}/approve`, `/suspend`; approval requires current identity/licence/vehicle review and audit record.
- `POST /admin/route-prices` — versioned fixed-route fare configuration.
- `GET /admin/reconciliation?from=&to=`; `POST /admin/ledger-adjustments` — append-only, reason-required, audited.
- `GET /admin/audit-logs?cursor=` — privileged, paginated, read-only.


## Support and safety
- `GET /support-tickets` — authenticated requester sees only their own tickets (up to 50, newest first).
- `POST /support-tickets` — authenticated user opens a ticket with `category` (`ride|food_order|payment|safety|driver|restaurant|account|other`) and a 10–3,000 character `description`; optional `ride_id` or `order_id` may be linked, but not both.
- Linked ride/order ownership is checked server-side before ticket creation; another user's ride/order cannot be attached. Tickets begin in `open` status. `GET /admin/support-tickets?status=open|in_progress|resolved|closed` — admin-only queue. `PATCH /admin/support-tickets/{id}` accepts a valid status; it assigns the current admin when `assigned_to` is omitted and writes an audit record. Customer access is restricted to the caller's own tickets.

## State and idempotency
Ride statuses: `searching, driver_assigned, driver_arriving, driver_arrived, in_progress, completed, cancelled_by_customer, cancelled_by_driver, cancelled_by_platform, no_driver_found`.
Food statuses: `submitted, accepted, preparing, ready_for_pickup, courier_assigned, picked_up, delivered, rejected, cancelled, delivery_failed`.
Payment/reconciliation status is independent from operational status. Status transitions are validated on the server and appended to event history. A repeated request with the same idempotency key and same payload returns the original result; same key with a different payload returns 409. All monetary side effects must be idempotent.
