-- Make driver ride and delivery state transitions safe to retry after ambiguous network failures.
-- The existing job RPC remains the sole authority for transition and cash rules.

create table if not exists public.sjelle_job_action_idempotency (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.sjelle_driver_profiles(user_id) on delete cascade,
  job_kind text not null check (job_kind in ('ride', 'delivery')),
  job_id uuid not null,
  idempotency_key text not null check (length(btrim(idempotency_key)) between 12 and 128),
  requested_status text not null check (length(btrim(requested_status)) between 1 and 40),
  cash_collected boolean not null default false,
  response jsonb not null check (jsonb_typeof(response) = 'object'),
  created_at timestamptz not null default now(),
  constraint sjelle_job_action_idempotency_driver_key_unique
    unique (driver_id, idempotency_key)
);

comment on table public.sjelle_job_action_idempotency is
  'Sjelle-only idempotency receipts for driver ride and delivery state transitions.';

alter table public.sjelle_job_action_idempotency enable row level security;
revoke all on table public.sjelle_job_action_idempotency from public, anon, authenticated, service_role;

create or replace function public.sjelle_driver_update_job_idempotent(
  p_driver_id uuid,
  p_job_kind text,
  p_job_id uuid,
  p_next_status text,
  p_cash_collected boolean,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_existing public.sjelle_job_action_idempotency%rowtype;
  v_key text;
  v_response jsonb;
begin
  if p_driver_id is null
     or p_job_kind is null or p_job_kind not in ('ride', 'delivery')
     or p_job_id is null
     or p_next_status is null
     or p_cash_collected is null then
    raise exception using errcode = 'P0001', message = 'INVALID_JOB_ACTION';
  end if;

  v_key := nullif(btrim(p_idempotency_key), '');
  if v_key is null or length(v_key) < 12 or length(v_key) > 128 then
    raise exception using errcode = 'P0001', message = 'INVALID_IDEMPOTENCY_KEY';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('sjelle_job_action:' || p_driver_id::text || ':' || v_key, 0)
  );

  select *
    into v_existing
    from public.sjelle_job_action_idempotency
   where driver_id = p_driver_id
     and idempotency_key = v_key
   for update;

  if found then
    if v_existing.job_kind is distinct from p_job_kind
       or v_existing.job_id is distinct from p_job_id
       or v_existing.requested_status is distinct from p_next_status
       or v_existing.cash_collected is distinct from p_cash_collected then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;

    return v_existing.response || jsonb_build_object('replayed', true);
  end if;

  v_response := public.sjelle_driver_update_job(
    p_driver_id,
    p_job_kind,
    p_job_id,
    p_next_status,
    p_cash_collected
  );

  if jsonb_typeof(v_response) is distinct from 'object' then
    raise exception using errcode = 'P0001', message = 'JOB_UPDATE_RESPONSE_INVALID';
  end if;

  insert into public.sjelle_job_action_idempotency (
    driver_id,
    job_kind,
    job_id,
    idempotency_key,
    requested_status,
    cash_collected,
    response
  ) values (
    p_driver_id,
    p_job_kind,
    p_job_id,
    v_key,
    p_next_status,
    p_cash_collected,
    v_response || jsonb_build_object('replayed', false)
  );

  return v_response || jsonb_build_object('replayed', false);
end;
$function$;

revoke all on function public.sjelle_driver_update_job_idempotent(uuid, text, uuid, text, boolean, text)
  from public, anon, authenticated;
grant execute on function public.sjelle_driver_update_job_idempotent(uuid, text, uuid, text, boolean, text)
  to service_role;
