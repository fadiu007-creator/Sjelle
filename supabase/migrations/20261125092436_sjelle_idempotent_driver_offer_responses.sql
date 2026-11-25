-- Make driver offer acceptance/rejection safe to retry after ambiguous network failures.
-- The existing offer RPC remains the sole authority for eligibility and assignment.

create table if not exists public.sjelle_offer_action_idempotency (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.sjelle_driver_profiles(user_id) on delete cascade,
  offer_id uuid not null references public.sjelle_driver_offers(id) on delete cascade,
  idempotency_key text not null check (length(btrim(idempotency_key)) between 12 and 128),
  requested_response text not null check (requested_response in ('accept', 'reject')),
  response jsonb not null check (jsonb_typeof(response) = 'object'),
  created_at timestamptz not null default now(),
  constraint sjelle_offer_action_idempotency_driver_key_unique
    unique (driver_id, idempotency_key)
);

comment on table public.sjelle_offer_action_idempotency is
  'Sjelle-only idempotency receipts for driver offer acceptance and rejection.';

alter table public.sjelle_offer_action_idempotency enable row level security;
revoke all on table public.sjelle_offer_action_idempotency from public, anon, authenticated, service_role;

create or replace function public.sjelle_respond_driver_offer_idempotent(
  p_driver_id uuid,
  p_offer_id uuid,
  p_response text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_existing public.sjelle_offer_action_idempotency%rowtype;
  v_key text;
  v_response jsonb;
begin
  if p_driver_id is null
     or p_offer_id is null
     or p_response is null
     or p_response not in ('accept', 'reject') then
    raise exception using errcode = 'P0001', message = 'INVALID_OFFER_RESPONSE';
  end if;

  v_key := nullif(btrim(p_idempotency_key), '');
  if v_key is null or length(v_key) < 12 or length(v_key) > 128 then
    raise exception using errcode = 'P0001', message = 'INVALID_IDEMPOTENCY_KEY';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('sjelle_offer_action:' || p_driver_id::text || ':' || v_key, 0)
  );

  select *
    into v_existing
    from public.sjelle_offer_action_idempotency
   where driver_id = p_driver_id
     and idempotency_key = v_key
   for update;

  if found then
    if v_existing.offer_id is distinct from p_offer_id
       or v_existing.requested_response is distinct from p_response then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;

    return v_existing.response || jsonb_build_object('replayed', true);
  end if;

  v_response := public.sjelle_respond_driver_offer(
    p_driver_id,
    p_offer_id,
    p_response
  );

  if jsonb_typeof(v_response) is distinct from 'object' then
    raise exception using errcode = 'P0001', message = 'OFFER_RESPONSE_INVALID';
  end if;

  insert into public.sjelle_offer_action_idempotency (
    driver_id,
    offer_id,
    idempotency_key,
    requested_response,
    response
  ) values (
    p_driver_id,
    p_offer_id,
    v_key,
    p_response,
    v_response || jsonb_build_object('replayed', false)
  );

  return v_response || jsonb_build_object('replayed', false);
end;
$function$;

revoke all on function public.sjelle_respond_driver_offer_idempotent(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.sjelle_respond_driver_offer_idempotent(uuid, uuid, text, text)
  to service_role;
