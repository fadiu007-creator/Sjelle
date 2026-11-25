-- Make customer ride cancellation safe to retry after an ambiguous network response.
-- The existing customer-scoped cancellation RPC remains authoritative for cancellability.

create table if not exists public.sjelle_ride_cancellation_idempotency (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references auth.users(id) on delete cascade,
  ride_id uuid not null references public.sjelle_rides(id) on delete cascade,
  idempotency_key text not null check (length(btrim(idempotency_key)) between 12 and 128),
  response jsonb not null check (jsonb_typeof(response) = 'object'),
  created_at timestamptz not null default now(),
  constraint sjelle_ride_cancellation_idempotency_customer_key_unique
    unique (customer_id, idempotency_key)
);

comment on table public.sjelle_ride_cancellation_idempotency is
  'Sjelle-only idempotency receipts for customer ride cancellation requests.';

alter table public.sjelle_ride_cancellation_idempotency enable row level security;
revoke all on table public.sjelle_ride_cancellation_idempotency from public, anon, authenticated, service_role;

create or replace function public.sjelle_cancel_ride_idempotent(
  p_customer_id uuid,
  p_ride_id uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_existing public.sjelle_ride_cancellation_idempotency%rowtype;
  v_key text;
  v_response jsonb;
begin
  if p_customer_id is null or p_ride_id is null then
    raise exception using errcode = 'P0001', message = 'INVALID_RIDE_CANCELLATION';
  end if;

  v_key := nullif(btrim(p_idempotency_key), '');
  if v_key is null or length(v_key) < 12 or length(v_key) > 128 then
    raise exception using errcode = 'P0001', message = 'INVALID_IDEMPOTENCY_KEY';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('sjelle_ride_cancel:' || p_customer_id::text || ':' || v_key, 0)
  );

  select *
    into v_existing
    from public.sjelle_ride_cancellation_idempotency
   where customer_id = p_customer_id
     and idempotency_key = v_key
   for update;

  if found then
    if v_existing.ride_id is distinct from p_ride_id then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;

    return v_existing.response || jsonb_build_object('replayed', true);
  end if;

  v_response := public.sjelle_cancel_ride(p_customer_id, p_ride_id);

  if jsonb_typeof(v_response) is distinct from 'object' then
    raise exception using errcode = 'P0001', message = 'RIDE_CANCELLATION_RESPONSE_INVALID';
  end if;

  insert into public.sjelle_ride_cancellation_idempotency (
    customer_id,
    ride_id,
    idempotency_key,
    response
  ) values (
    p_customer_id,
    p_ride_id,
    v_key,
    v_response || jsonb_build_object('replayed', false)
  );

  return v_response || jsonb_build_object('replayed', false);
end;
$function$;

revoke all on function public.sjelle_cancel_ride_idempotent(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.sjelle_cancel_ride_idempotent(uuid, uuid, text)
  to service_role;
