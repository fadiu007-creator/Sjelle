# Sjelle cash collection and reconciliation

## What is implemented

- Cash rides and food deliveries post collection entries only after the authoritative job workflow marks them completed/delivered and the cash status changes to `collected`.
- Each successful posting creates two signed entries in `sjelle_ledger_entries`: a negative `customer_cash_due` entry to clear the amount due and a positive `driver_cash_collected` entry assigned to the collecting driver.
- Deterministic unique idempotency keys make retries safe. The trigger and entries share the same database transaction as the status update; a ledger failure rolls back the status change.
- Existing completed/delivered cash jobs already marked collected were backfilled by the migration using the same idempotent posting path.
- Admins can inspect entries and signed totals at `GET /api/v1/admin/reconciliation?from=YYYY-MM-DD&to=YYYY-MM-DD`. The admin portal provides date selection and paginated entry review.

## Applied migrations

The existing `zikos` project already has these Sjelle migrations applied:

- `20261108082416_sjelle_cash_collection_ledger.sql` — creates the cash-collection ledger trigger and idempotent postings.
- `20261117082811_sjelle_admin_reconciliation_keyset_pagination.sql` — adds the ordered ledger index and the service-role-only `sjelle_admin_reconciliation_page` RPC.

Do not reapply these migrations manually to the current project. For a separate environment, apply the repository migrations in version order after confirming the target is the intended Sjelle database and a suitable backup exists.

## Operational use

1. Complete a test cash ride in a controlled test setup. Verify one `customer_cash_due` entry and one `driver_cash_collected` entry exist for the same ride and amount.
2. Complete a test cash delivery and verify the same pair exists against the food order and its assigned delivery driver.
3. Repeat the completion request with the same job; verify the state transition is rejected as invalid and no duplicate ledger rows appear.
4. Compare the admin portal totals with the underlying ledger. Follow the cursor until `has_more=false` before treating the entry list as complete.
5. Reconcile declared driver cash with physical cash handover and bank/cash records outside this endpoint; record discrepancies only through a reviewed adjustment/reversal process.

## Example read-only SQL checks

```sql
-- Recent signed totals by account type
select account_type, count(*) as entries, sum(amount_cents) as net_amount_cents
from public.sjelle_ledger_entries
where created_at >= now() - interval '30 days'
group by account_type
order by account_type;

-- Find duplicate-looking postings; idempotency_key is uniquely constrained
select idempotency_key, count(*)
from public.sjelle_ledger_entries
group by idempotency_key
having count(*) > 1;

-- Inspect the two collection movements for one ride (replace with a real UUID)
select account_type, account_user_id, amount_cents, entry_type, idempotency_key, created_at
from public.sjelle_ledger_entries
where related_ride_id = '00000000-0000-4000-8000-000000000001'
order by created_at, account_type;
```

## Paginated admin reconciliation

The API calls the service-role-only RPC `sjelle_admin_reconciliation_page`. It validates the date range, page size and cursor, calculates full-period counts and signed totals, and returns a deterministic keyset page. The API validates the response shape, EUR currency, safe integer cents, full-period count reconciliation and cursor consistency before exposing the report.

- Default page size: 100 entries.
- Maximum page size: 250 entries.
- The summary totals cover the complete selected date range, not only the visible page.
- Use `meta.next_cursor` with `cursor_created_at` and `cursor_id` until `meta.has_more=false`.
- The admin portal maintains a cursor stack and resets it whenever the date range changes.

## Important limitations before launch

This is a cash-collection journal, not a complete double-entry accounting or settlement product. It does not yet calculate or post platform commission, driver net earnings, restaurant payable, courier delivery earnings, cash handover, refunds, disputes, or settlement adjustments. Online payments remain disabled. A complete ledger export must traverse all pages; do not treat the first page as the entire period. Real cash lifecycle testing and an operational handover/reconciliation procedure are still required before public launch.
