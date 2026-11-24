# Sjelle cash collection, handover and reconciliation

## What is implemented

- Cash rides and food deliveries post collection entries only after the authoritative job workflow marks them completed/delivered and the cash status changes to `collected`.
- Each successful posting creates two signed entries in `sjelle_ledger_entries`: a negative `customer_cash_due` entry to clear the amount due and a positive `driver_cash_collected` entry assigned to the collecting driver.
- Cash collection and administrator handover now share a per-driver transaction advisory lock. A handover cannot race a newly completed cash job and overdraw the driver's cash-held balance.
- An administrator can record cash physically received from a driver in the admin portal. The database rejects an amount above that driver's current `driver_cash_collected` balance.
- Each handover creates an immutable `sjelle_cash_handovers` record and two balanced ledger movements: a negative `driver_cash_collected` entry and a positive `platform_cash_on_hand` entry.
- Handover writes are idempotent. Replaying the same key and payload returns the original handover; reusing the key with a different driver, amount or reference is rejected.
- The handover RPC checks the authenticated admin role again inside the database. The handover table has RLS enabled and no direct client or service-role table grants; writes occur only through the restricted security-definer RPC.
- Admins can inspect signed ledger totals and entries at `GET /api/v1/admin/reconciliation?from=YYYY-MM-DD&to=YYYY-MM-DD`. The paginated response now identifies cash-handover entries as well as rides and food orders.
- The admin portal exposes current non-zero driver cash-held balances and requires an explicit confirmation before recording physical receipt.

## Applied migrations

The existing `zikos` project already has these Sjelle migrations applied:

- `20261108082416_sjelle_cash_collection_ledger.sql` — creates the cash-collection ledger trigger and idempotent postings.
- `20261117082811_sjelle_admin_reconciliation_keyset_pagination.sql` — adds the ordered ledger index and the service-role-only `sjelle_admin_reconciliation_page` RPC.
- `20261124083441_sjelle_driver_cash_handover_workflow.sql` — adds immutable handover records, balanced handover ledger entries, serialized driver balances and admin-only APIs.

Do not reapply these migrations manually to the current project. For a separate environment, apply repository migrations in version order after confirming the target is the intended Sjelle database and a suitable backup exists.

## Operational use

1. Complete a real cash ride in a controlled test setup. Verify one `customer_cash_due` entry and one `driver_cash_collected` entry exist for the same ride and amount.
2. Complete a real cash delivery and verify the same pair exists against the food order and its assigned delivery driver.
3. In the admin portal, compare a driver's current cash-held balance with the physical cash received. Enter only the amount physically received and an optional receipt reference.
4. Confirm the handover. Verify one `sjelle_cash_handovers` row and two ledger entries exist for that handover; their signed amounts must net to zero.
5. Retry an ambiguous network request with the same idempotency key. Verify the original handover is returned and no duplicate ledger rows appear.
6. Attempting to hand over more than the driver's current cash-held balance must fail with `CASH_HANDOVER_EXCEEDS_BALANCE`.
7. Follow reconciliation cursors until `has_more=false` before treating the entry list as complete.

## Example read-only SQL checks

```sql
-- Current cash held by each driver after recorded handovers
select account_user_id as driver_id, sum(amount_cents) as cash_held_cents
from public.sjelle_ledger_entries
where account_type = 'driver_cash_collected'
group by account_user_id
having sum(amount_cents) <> 0
order by cash_held_cents desc;

-- Handover ledger pairs must balance and contain one movement per account
select related_cash_handover_id,
       count(*) as entries,
       count(*) filter (where account_type = 'driver_cash_collected') as driver_entries,
       count(*) filter (where account_type = 'platform_cash_on_hand') as platform_entries,
       sum(amount_cents) as net_amount_cents
from public.sjelle_ledger_entries
where related_cash_handover_id is not null
group by related_cash_handover_id
having count(*) <> 2
    or count(*) filter (where account_type = 'driver_cash_collected') <> 1
    or count(*) filter (where account_type = 'platform_cash_on_hand') <> 1
    or sum(amount_cents) <> 0;

-- Inspect a real handover (replace with its UUID)
select driver_id, received_by, amount_cents, balance_before_cents,
       balance_after_cents, reference, created_at
from public.sjelle_cash_handovers
where id = '00000000-0000-4000-8000-000000000001';
```

## Paginated admin reconciliation

The API calls the service-role-only RPC `sjelle_admin_reconciliation_page`. It validates the date range, page size and cursor, calculates full-period counts and signed totals, and returns a deterministic keyset page. The API validates the response shape, EUR currency, safe integer cents, full-period count reconciliation and cursor consistency before exposing the report.

- Default page size: 100 entries.
- Maximum page size: 250 entries.
- Summary totals cover the complete selected date range, not only the visible page.
- Use `meta.next_cursor` with `cursor_created_at` and `cursor_id` until `meta.has_more=false`.
- The admin portal maintains a cursor stack and resets it whenever the date range changes.
- Handover rows are linked through `related_cash_handover_id`, not mislabelled as unlinked ledger entries.

## Important limitations before launch

This is a cash-collection and physical-handover journal, not a complete earnings, commission or settlement product. It does not yet calculate platform commission, driver net earnings, restaurant payable, courier delivery earnings, refunds, disputes or settlement adjustments. `platform_cash_on_hand` records the physical cash Sjelle's administrator confirms receiving; it does not represent a bank deposit. Online payments remain disabled. Real cash lifecycle testing and a documented physical handover procedure are still required before public launch.
