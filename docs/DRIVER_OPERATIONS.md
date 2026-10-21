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
