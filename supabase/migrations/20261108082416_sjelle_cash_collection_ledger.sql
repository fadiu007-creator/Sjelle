-- Post cash-collection ledger entries exactly once when a driver completes a cash job.
-- Additive to the shared zikos project: only sjelle_* objects are touched.
-- Entries are signed settlement movements: customer cash due is cleared (-amount)
-- and the driver cash-collected account records the same amount (+amount).

create or replace function public.sjelle_record_cash_collection_ledger()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_amount bigint;
  v_driver_id uuid;
  v_customer_id uuid;
  v_kind text;
  v_job_id uuid;
begin
  if new.sjelle_cash_status is distinct from 'collected'::public.sjelle_cash_status
     or old.sjelle_cash_status = 'collected'::public.sjelle_cash_status then
    return new;
  end if;

  if tg_table_name = 'sjelle_rides' then
    if new.payment_method <> 'cash' or new.status <> 'completed' then return new; end if;
    v_amount := coalesce(new.final_amount_cents, new.quoted_amount_cents);
    v_driver_id := new.driver_id;
    v_customer_id := new.customer_id;
    v_kind := 'ride';
    v_job_id := new.id;
  elsif tg_table_name = 'sjelle_food_orders' then
    if new.payment_method <> 'cash' or new.status <> 'delivered' then return new; end if;
    v_amount := new.total_cents;
    v_customer_id := new.customer_id;
    v_kind := 'delivery';
    v_job_id := new.id;
    select j.driver_id into v_driver_id
      from public.sjelle_delivery_jobs j
      where j.order_id = new.id
      order by j.created_at desc
      limit 1;
    if v_driver_id is null then
      raise exception using errcode = 'P0001', message = 'CASH_COLLECTION_DRIVER_MISSING';
    end if;
  else
    raise exception using errcode = 'P0001', message = 'UNSUPPORTED_CASH_LEDGER_SOURCE';
  end if;

  -- Zero-value jobs are permitted by the schema, but the ledger intentionally
  -- forbids zero-amount entries; leave them collected without a zero-value posting.
  if v_amount is null or v_amount <= 0 then return new; end if;

  insert into public.sjelle_ledger_entries
    (related_ride_id, related_order_id, account_type, account_user_id,
     amount_cents, entry_type, idempotency_key, metadata)
  values
    (case when v_kind = 'ride' then v_job_id else null end,
     case when v_kind = 'delivery' then v_job_id else null end,
     'customer_cash_due', v_customer_id, -v_amount,
     'cash_collection_customer_due_cleared', v_kind || ':' || v_job_id::text || ':cash:customer_due',
     jsonb_build_object('job_kind', v_kind, 'job_id', v_job_id, 'payment_method', 'cash')),
    (case when v_kind = 'ride' then v_job_id else null end,
     case when v_kind = 'delivery' then v_job_id else null end,
     'driver_cash_collected', v_driver_id, v_amount,
     'cash_collection_driver_received', v_kind || ':' || v_job_id::text || ':cash:driver_collected',
     jsonb_build_object('job_kind', v_kind, 'job_id', v_job_id, 'payment_method', 'cash'))
  on conflict (idempotency_key) do nothing;

  return new;
end;
$function$;

revoke all on function public.sjelle_record_cash_collection_ledger() from public, anon, authenticated;
grant execute on function public.sjelle_record_cash_collection_ledger() to service_role;

drop trigger if exists sjelle_ride_cash_collection_ledger on public.sjelle_rides;
create trigger sjelle_ride_cash_collection_ledger
after update of status, sjelle_cash_status on public.sjelle_rides
for each row execute function public.sjelle_record_cash_collection_ledger();

drop trigger if exists sjelle_food_cash_collection_ledger on public.sjelle_food_orders;
create trigger sjelle_food_cash_collection_ledger
after update of status, sjelle_cash_status on public.sjelle_food_orders
for each row execute function public.sjelle_record_cash_collection_ledger();

-- Reconcile eligible already-collected cash jobs as a one-time migration backfill.
-- The unique idempotency keys make this safe if a deployment/replay is retried.
do $backfill$
declare
  r record;
begin
  for r in
    select id from public.sjelle_rides
    where payment_method = 'cash' and status = 'completed' and sjelle_cash_status = 'collected'
  loop
    update public.sjelle_rides set sjelle_cash_status = 'due' where id = r.id;
    update public.sjelle_rides set sjelle_cash_status = 'collected' where id = r.id;
  end loop;

  for r in
    select id from public.sjelle_food_orders
    where payment_method = 'cash' and status = 'delivered' and sjelle_cash_status = 'collected'
  loop
    update public.sjelle_food_orders set sjelle_cash_status = 'due' where id = r.id;
    update public.sjelle_food_orders set sjelle_cash_status = 'collected' where id = r.id;
  end loop;
end;
$backfill$;
