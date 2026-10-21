# Sjelle cash collection and reconciliation

## What is implemented

- Cash rides and food deliveries only post collection entries after the authoritative job workflow marks them complete/delivered and the cash status changes to `collected`.
- Each successful posting creates two signed entries in `sjelle_ledger_entries`: a negative `customer_cash_due` entry to clear the amount due and a positive `driver_cash_collected` entry assigned to the collecting driver.
- Deterministic unique idempotency keys make retries safe. The trigger and entries are in the same database transaction as the status update; a ledger failure rolls back the status change.
- Existing completed/delivered cash jobs already marked collected are backfilled by the migration. The backfill uses the same idempotent posting path.
- Admins can inspect entries and signed totals at `GET /api/v1/admin/reconciliation?from=YYYY-MM-DD&to=YYYY-MM-DD`; the admin portal provides date selection and an entry list.

## Operational use

1. Deploy the additive migration `20261021100000_sjelle_cash_collection_ledger.sql` to the existing `zikos` project only after reviewing the SQL and confirming a backup is available.
2. Complete a test cash ride in a non-production test setup. Verify one `customer_cash_due` entry and one `driver_cash_collected` entry exist for the same ride and amount.
3. Complete a test cash delivery and verify the same pair exists against the food order and its assigned delivery driver.
4. Repeat the completion request with the same job; verify the job transition is rejected as invalid and no duplicate ledger rows appear.
5. Compare the admin portal totals with the underlying ledger. If `possibly_truncated` is true, narrow the date range before relying on the result.
6. Reconcile declared driver cash with physical cash handover and bank/cash records outside this endpoint; record discrepancies using a reviewed adjustment/reversal process.

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

## Important limitations before launch

This is a cash-collection journal, not a complete double-entry accounting or settlement product. It does not yet calculate or post platform commission, driver net earnings, restaurant payable, courier delivery earnings, cash handover, refunds, disputes, or settlement adjustments. The API returns at most 1,000 rows per request and marks a result that reaches that cap as potentially truncated. Do not use a truncated result as a complete export. Keep all cities disabled until finance rules, real database migration tests, operational reconciliation, and legal/tax review are complete.
