-- Sjelle-only cash handover journal. Cash collected by a driver remains a driver-held
-- liability until an administrator physically receives it and records the handover.
create table if not exists public.sjelle_cash_handovers (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.sjelle_driver_profiles(user_id) on delete restrict,
  received_by uuid not null references auth.users(id) on delete restrict,
  amount_cents bigint not null check (amount_cents > 0),
  balance_before_cents bigint not null check (balance_before_cents > 0),
  balance_after_cents bigint not null check (balance_after_cents >= 0),
  currency char(3) not null default 'EUR' check (currency = 'EUR'),
  reference text check (reference is null or (length(reference) between 1 and 120)),
  idempotency_key text not null unique check (length(idempotency_key) between 12 and 128),
  created_at timestamptz not null default now(),
  constraint sjelle_cash_handovers_balance_math
    check (balance_after_cents = balance_before_cents - amount_cents)
);

create index if not exists sjelle_cash_handovers_driver_created_idx
  on public.sjelle_cash_handovers (driver_id, created_at desc, id desc);

alter table public.sjelle_cash_handovers enable row level security;
revoke all on table public.sjelle_cash_handovers from public, anon, authenticated, service_role;

alter table public.sjelle_ledger_entries
  add column if not exists related_cash_handover_id uuid;

do $constraints$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.sjelle_ledger_entries'::regclass
      and conname = 'sjelle_ledger_entries_related_cash_handover_id_fkey'
  ) then
    alter table public.sjelle_ledger_entries
      add constraint sjelle_ledger_entries_related_cash_handover_id_fkey
      foreign key (related_cash_handover_id)
      references public.sjelle_cash_handovers(id)
      on delete restrict;
  end if;
end;
$constraints$;

alter table public.sjelle_ledger_entries
  drop constraint if exists sjelle_ledger_entries_check;
alter table public.sjelle_ledger_entries
  add constraint sjelle_ledger_entries_check
  check (
    related_ride_id is not null
    or related_order_id is not null
    or related_cash_handover_id is not null
  );

alter table public.sjelle_ledger_entries
  drop constraint if exists sjelle_ledger_entries_account_type_check;
alter table public.sjelle_ledger_entries
  add constraint sjelle_ledger_entries_account_type_check
  check (account_type in (
    'customer_cash_due',
    'driver_cash_collected',
    'driver_payable',
    'platform_revenue',
    'platform_cash_on_hand',
    'merchant_payable',
    'refund_due',
    'adjustment'
  ));

create unique index if not exists sjelle_ledger_cash_handover_account_idx
  on public.sjelle_ledger_entries (related_cash_handover_id, account_type)
  where related_cash_handover_id is not null;

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
      order by j.created_at desc, j.id desc
      limit 1;
  else
    raise exception using errcode = 'P0001', message = 'UNSUPPORTED_CASH_LEDGER_SOURCE';
  end if;

  if v_driver_id is null then
    raise exception using errcode = 'P0001', message = 'CASH_COLLECTION_DRIVER_MISSING';
  end if;

  -- Serialize cash collection with administrator handovers for this driver.
  perform pg_advisory_xact_lock(hashtextextended('sjelle_cash_driver:' || v_driver_id::text, 0));

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

create or replace function public.sjelle_admin_driver_cash_balances(p_actor_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_data jsonb;
begin
  if p_actor_id is null or not exists (
    select 1 from public.sjelle_user_roles
    where user_id = p_actor_id and role = 'admin'::public.sjelle_app_role
  ) then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'driver_id', balances.driver_id,
        'review_status', balances.review_status,
        'city_id', balances.city_id,
        'online', balances.online,
        'balance_cents', balances.balance_amount::text,
        'last_collection_at', balances.last_collection_at
      )
      order by balances.balance_amount desc, balances.driver_id
    ),
    '[]'::jsonb
  )
  into v_data
  from (
    select
      d.user_id as driver_id,
      d.review_status::text as review_status,
      d.city_id,
      d.online,
      coalesce(sum(l.amount_cents), 0) as balance_amount,
      max(l.created_at) filter (
        where l.entry_type = 'cash_collection_driver_received' and l.amount_cents > 0
      ) as last_collection_at
    from public.sjelle_driver_profiles d
    left join public.sjelle_ledger_entries l
      on l.account_user_id = d.user_id
     and l.account_type = 'driver_cash_collected'
    group by d.user_id, d.review_status, d.city_id, d.online
    having coalesce(sum(l.amount_cents), 0) <> 0
  ) balances;

  return v_data;
end;
$function$;

revoke all on function public.sjelle_admin_driver_cash_balances(uuid) from public, anon, authenticated;
grant execute on function public.sjelle_admin_driver_cash_balances(uuid) to service_role;

create or replace function public.sjelle_record_driver_cash_handover(
  p_actor_id uuid,
  p_driver_id uuid,
  p_amount_cents bigint,
  p_idempotency_key text,
  p_reference text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_existing public.sjelle_cash_handovers%rowtype;
  v_handover public.sjelle_cash_handovers%rowtype;
  v_key text;
  v_reference text;
  v_balance_before numeric;
  v_balance_after numeric;
  v_metadata jsonb;
begin
  if p_actor_id is null or not exists (
    select 1 from public.sjelle_user_roles
    where user_id = p_actor_id and role = 'admin'::public.sjelle_app_role
  ) then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;

  v_key := nullif(btrim(p_idempotency_key), '');
  v_reference := nullif(btrim(coalesce(p_reference, '')), '');
  if p_driver_id is null
     or p_amount_cents is null or p_amount_cents <= 0
     or v_key is null or length(v_key) < 12 or length(v_key) > 128
     or length(v_reference) > 120 then
    raise exception using errcode = 'P0001', message = 'INVALID_CASH_HANDOVER';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('sjelle_cash_handover_key:' || v_key, 0));

  select * into v_existing
    from public.sjelle_cash_handovers
   where idempotency_key = v_key;
  if found then
    if v_existing.driver_id is distinct from p_driver_id
       or v_existing.amount_cents is distinct from p_amount_cents
       or v_existing.reference is distinct from v_reference then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return jsonb_build_object(
      'id', v_existing.id,
      'driver_id', v_existing.driver_id,
      'amount_cents', v_existing.amount_cents,
      'currency', v_existing.currency,
      'balance_before_cents', v_existing.balance_before_cents,
      'balance_after_cents', v_existing.balance_after_cents,
      'reference', v_existing.reference,
      'replayed', true
    );
  end if;

  perform pg_advisory_xact_lock(hashtextextended('sjelle_cash_driver:' || p_driver_id::text, 0));

  perform 1
    from public.sjelle_driver_profiles
   where user_id = p_driver_id
   for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'DRIVER_NOT_FOUND';
  end if;

  select coalesce(sum(amount_cents), 0)
    into v_balance_before
    from public.sjelle_ledger_entries
   where account_type = 'driver_cash_collected'
     and account_user_id = p_driver_id;

  if v_balance_before > 9223372036854775807 then
    raise exception using errcode = 'P0001', message = 'CASH_BALANCE_OVERFLOW';
  end if;
  if v_balance_before < p_amount_cents then
    raise exception using errcode = 'P0001', message = 'CASH_HANDOVER_EXCEEDS_BALANCE';
  end if;

  v_balance_after := v_balance_before - p_amount_cents;

  insert into public.sjelle_cash_handovers (
    driver_id, received_by, amount_cents, balance_before_cents, balance_after_cents,
    reference, idempotency_key
  ) values (
    p_driver_id, p_actor_id, p_amount_cents, v_balance_before::bigint, v_balance_after::bigint,
    v_reference, v_key
  )
  returning * into v_handover;

  v_metadata := jsonb_build_object(
    'cash_handover_id', v_handover.id,
    'driver_id', p_driver_id,
    'received_by', p_actor_id,
    'reference', v_reference
  );

  insert into public.sjelle_ledger_entries (
    related_ride_id, related_order_id, related_cash_handover_id,
    account_type, account_user_id, amount_cents, currency,
    entry_type, idempotency_key, metadata
  ) values
    (
      null, null, v_handover.id,
      'driver_cash_collected', p_driver_id, -p_amount_cents, 'EUR',
      'driver_cash_handover_out', 'cash-handover:' || v_handover.id::text || ':driver',
      v_metadata
    ),
    (
      null, null, v_handover.id,
      'platform_cash_on_hand', null, p_amount_cents, 'EUR',
      'platform_cash_handover_in', 'cash-handover:' || v_handover.id::text || ':platform',
      v_metadata
    );

  insert into public.sjelle_audit_logs (
    actor_id, action, target_type, target_id, reason, metadata
  ) values (
    p_actor_id,
    'cash_handover.recorded',
    'cash_handover',
    v_handover.id::text,
    v_reference,
    jsonb_build_object(
      'driver_id', p_driver_id,
      'amount_cents', p_amount_cents,
      'balance_before_cents', v_balance_before,
      'balance_after_cents', v_balance_after,
      'currency', 'EUR'
    )
  );

  return jsonb_build_object(
    'id', v_handover.id,
    'driver_id', p_driver_id,
    'amount_cents', p_amount_cents,
    'currency', 'EUR',
    'balance_before_cents', v_balance_before,
    'balance_after_cents', v_balance_after,
    'reference', v_reference,
    'replayed', false
  );
end;
$function$;

revoke all on function public.sjelle_record_driver_cash_handover(uuid, uuid, bigint, text, text) from public, anon, authenticated;
grant execute on function public.sjelle_record_driver_cash_handover(uuid, uuid, bigint, text, text) to service_role;

create or replace function public.sjelle_admin_reconciliation_page(
  p_from timestamptz,
  p_to timestamptz,
  p_limit integer,
  p_cursor_created_at timestamptz,
  p_cursor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_total_entries text;
  v_summary jsonb;
  v_data jsonb;
  v_has_more boolean;
  v_next_cursor jsonb;
begin
  if p_from is null or p_to is null or p_from >= p_to then
    raise exception using errcode = '22023', message = 'INVALID_DATE_RANGE';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 250 then
    raise exception using errcode = '22023', message = 'INVALID_PAGE_SIZE';
  end if;
  if (p_cursor_created_at is null) <> (p_cursor_id is null) then
    raise exception using errcode = '22023', message = 'INVALID_RECONCILIATION_CURSOR';
  end if;
  if p_cursor_created_at is not null
    and (p_cursor_created_at < p_from or p_cursor_created_at >= p_to) then
    raise exception using errcode = '22023', message = 'INVALID_RECONCILIATION_CURSOR';
  end if;

  with summary_groups as (
    select
      account_type,
      count(*)::text as entry_count,
      coalesce(sum(amount_cents), 0)::text as net_amount_cents
    from public.sjelle_ledger_entries
    where created_at >= p_from and created_at < p_to
    group by account_type
  ),
  summary_totals as (
    select count(*)::text as total_entries
    from public.sjelle_ledger_entries
    where created_at >= p_from and created_at < p_to
  ),
  summary_json as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'account_type', account_type,
          'entry_count', entry_count,
          'net_amount_cents', net_amount_cents
        ) order by account_type
      ),
      '[]'::jsonb
    ) as summary
    from summary_groups
  ),
  page_rows as (
    select
      id,
      related_ride_id,
      related_order_id,
      related_cash_handover_id,
      account_type,
      account_user_id,
      amount_cents::text as amount_cents,
      currency::text as currency,
      entry_type,
      idempotency_key,
      metadata,
      created_at
    from public.sjelle_ledger_entries
    where created_at >= p_from and created_at < p_to
      and (
        p_cursor_created_at is null
        or (created_at, id) < (p_cursor_created_at, p_cursor_id)
      )
    order by created_at desc, id desc
    limit (p_limit + 1)
  ),
  visible_rows as (
    select *
    from page_rows
    order by created_at desc, id desc
    limit p_limit
  ),
  page_state as (
    select count(*) > p_limit as has_more
    from page_rows
  ),
  page_json as (
    select coalesce(
      jsonb_agg(to_jsonb(v) order by v.created_at desc, v.id desc),
      '[]'::jsonb
    ) as data
    from visible_rows v
  ),
  last_visible as (
    select created_at, id
    from visible_rows
    order by created_at asc, id asc
    limit 1
  )
  select
    totals.total_entries,
    summary.summary,
    page.data,
    state.has_more,
    case
      when state.has_more then (
        select jsonb_build_object('created_at', created_at, 'id', id)
        from last_visible
      )
      else null
    end
  into v_total_entries, v_summary, v_data, v_has_more, v_next_cursor
  from summary_totals totals
  cross join summary_json summary
  cross join page_json page
  cross join page_state state;

  return jsonb_build_object(
    'data', v_data,
    'summary', v_summary,
    'meta', jsonb_build_object(
      'total_entries', v_total_entries,
      'returned', jsonb_array_length(v_data),
      'limit', p_limit,
      'has_more', v_has_more,
      'next_cursor', v_next_cursor
    )
  );
end;
$function$;

revoke all on function public.sjelle_admin_reconciliation_page(timestamptz, timestamptz, integer, timestamptz, uuid)
  from public, anon, authenticated;
grant execute on function public.sjelle_admin_reconciliation_page(timestamptz, timestamptz, integer, timestamptz, uuid)
  to service_role;

comment on table public.sjelle_cash_handovers is
  'Immutable Sjelle records of cash physically received from drivers; each handover has two balanced ledger movements.';
comment on function public.sjelle_record_driver_cash_handover(uuid, uuid, bigint, text, text) is
  'Records an admin-confirmed physical driver cash handover, bounded by the driver cash ledger balance and idempotent by key.';
