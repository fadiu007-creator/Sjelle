# Driver operations and cash-control runbook

This runbook documents the current cash-first driver job flow. It is an operational checklist, not evidence that a production environment has been deployed or that a driver actually handed over cash.

## Job status API

Endpoint:

`POST /api/v1/driver/jobs/{ride|delivery}/{job_id}/status`

Authentication: Supabase access JWT. The API derives the driver identity from the validated token; never trust a driver ID supplied in the request body.

Allowed ride statuses from this endpoint: `driver_arriving`, `driver_arrived`, `in_progress`, `completed`.

Allowed delivery statuses: `arriving`, `arrived`, `picked_up`, `delivered`.

Terminal statuses require explicit `cash_collected: true`:
- Ride: `completed`
- Delivery: `delivered`

Cash confirmation is rejected on non-terminal statuses. This avoids recording a collection declaration while the job is still active. Invalid requests are rejected before the database RPC is called. The database function `sjelle_driver_update_job` remains responsible for assignment checks, valid state transitions, and transactional persistence.

Example completion request:

```json
{
  "status": "completed",
  "cash_collected": true
}
```

Relevant validation errors:
- `INVALID_JOB_TRANSITION`: unknown status or malformed cash flag.
- `CASH_COLLECTION_CONFIRMATION_REQUIRED`: terminal status submitted without `cash_collected: true`.
- `CASH_CONFIRMATION_ONLY_ON_COMPLETION`: cash confirmation submitted for a non-terminal status.
- `UNAUTHENTICATED`: missing or invalid access token.
- `DRIVER_NOT_APPROVED` / `JOB_NOT_FOUND`: database-owned eligibility and resource checks.


## Atomic driver availability and assignment

Driver availability now uses the service-role-only RPC `sjelle_set_driver_availability`. The RPC locks the driver's profile row, checks for an active ride/delivery before going offline or changing mode, and then updates availability in the same transaction.

Database triggers `sjelle_guard_ride_driver_assignment` and `sjelle_guard_delivery_driver_assignment` lock that same driver row before a job assignment. They reject assignment if the driver is offline, unapproved, in the wrong mode, or already assigned to another active job. This shared row lock serializes availability changes and assignment attempts.

- [ ] Run API tests and type-check after the latest commits.
- [ ] Verify both RPC execution grants remain limited to `service_role`.
- [ ] In staging, test simultaneous availability-off and offer acceptance; exactly one operation must win safely.
- [ ] Test that an active ride blocks delivery assignment and an active delivery blocks ride assignment.
- [ ] Confirm the driver can go offline and switch modes after the active job reaches a terminal state.

## Database-enforced cash confirmation

The `sjelle_driver_update_job` RPC now independently rejects terminal ride/delivery transitions unless `p_cash_collected=true`, and rejects cash confirmation on non-terminal transitions. This duplicates the API's validation at the database boundary as defense in depth. The RPC remains executable only by `service_role`.

This is still a driver declaration, not proof that money changed hands. Reconciliation, receipts and commission accounting remain separate work.

## Cash-control limitation

A boolean sent by a driver is a declaration, not proof of payment. The current API guard prevents obvious premature/missing confirmations, but must not be treated as a cash ledger, commission calculation, or reconciliation system.

Before production launch, verify in the database transaction that:
1. The job is assigned to the authenticated, approved driver.
2. The requested status is a valid transition from the current persisted status.
3. A job can create at most one collection/settlement record, including under retries and concurrent requests.
4. Job status, cash declaration, driver payable, platform commission, and immutable audit/event records are committed atomically where applicable.
5. A failed transaction leaves none of those effects partially written.
6. Admin reconciliation can compare completed cash jobs against driver declarations, commissions, and any later reason-coded adjustments.
7. Corrections are append-only and audited; do not silently rewrite historical cash movements.

Do not add a second ledger write in the Worker until the SQL RPC and current schema have been inspected. Duplicating the same financial side effect in the API and database can cause double entries.

## Pre-launch verification

- [ ] Run `npm test` and `npm run typecheck` from `apps/api`.
- [ ] Review the SQL definition of `sjelle_driver_update_job` and prove duplicate terminal requests cannot double-book financial effects.
- [ ] Verify ride and delivery status transitions against the persisted state machine.
- [ ] Test cash confirmation with concurrent requests and network retries against a disposable staging database.
- [ ] Confirm driver earnings and admin reconciliation use the same authoritative ledger source.
- [ ] Deploy to Cloudflare staging and verify health/readiness and real ride/food/driver flows before considering production.
- [ ] Keep all changes additive under the existing `sjelle_*` schema; do not modify shared Dhuroje/Kafja data or create another Supabase project.

## Current verification boundary

The Worker regression tests cover request-level cash validation and the absence of an RPC call for rejected input. They do not prove the SQL transaction is idempotent, prove cash changed hands, or substitute for staging tests. CI and Cloudflare deployment must be checked independently.
