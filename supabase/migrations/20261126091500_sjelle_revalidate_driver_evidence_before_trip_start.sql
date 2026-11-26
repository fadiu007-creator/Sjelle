-- Revalidate mandatory driver evidence at the last safe point before a ride starts
-- or a food order is picked up. Once a trip has started, do not interrupt it.
--
-- Readiness-evidence mutations already lock the driver profile first. This guard
-- takes the same lock before reading the latest documents and approved vehicle.

create or replace function public.sjelle_assert_driver_job_readiness(
  p_driver_id uuid,
  p_job_kind text,
  p_vehicle_type text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_profile_status public.sjelle_driver_review_status;
  v_valid_document_count bigint;
begin
  if p_driver_id is null
     or p_job_kind is null
     or p_job_kind not in ('ride', 'delivery')
     or (p_job_kind = 'ride' and nullif(btrim(p_vehicle_type), '') is null) then
    raise exception using errcode = 'P0001', message = 'INVALID_DRIVER_READINESS_CHECK';
  end if;

  select review_status
    into v_profile_status
    from public.sjelle_driver_profiles
   where user_id = p_driver_id
   for update;

  if not found or v_profile_status is distinct from 'approved'::public.sjelle_driver_review_status then
    raise exception using errcode = 'P0001', message = 'DRIVER_VERIFICATION_REQUIRED';
  end if;

  with latest_documents as (
    select distinct on (document_type)
      document_type,
      review_status,
      expires_at
    from public.sjelle_driver_documents
    where driver_id = p_driver_id
      and document_type in ('identity', 'driving_licence', 'vehicle_registration', 'insurance')
    order by document_type, created_at desc, id desc
  )
  select count(*)
    into v_valid_document_count
    from latest_documents
   where review_status = 'approved'
     and (expires_at is null or expires_at >= current_date);

  if v_valid_document_count <> 4 then
    raise exception using errcode = 'P0001', message = 'DRIVER_VERIFICATION_REQUIRED';
  end if;

  if not exists (
    select 1
      from public.sjelle_vehicles v
     where v.driver_id = p_driver_id
       and v.review_status = 'approved'
       and (v.document_expires_at is null or v.document_expires_at >= current_date)
       and (p_job_kind = 'delivery' or v.vehicle_type = p_vehicle_type)
  ) then
    raise exception using errcode = 'P0001', message = 'DRIVER_VERIFICATION_REQUIRED';
  end if;
end;
$function$;

comment on function public.sjelle_assert_driver_job_readiness(uuid, text, text) is
  'Sjelle-only final evidence check for ride commencement and courier pickup; serializes with document and vehicle review changes.';

create or replace function public.sjelle_guard_verified_driver_before_trip_start()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if tg_table_name = 'sjelle_rides' then
    if new.status::text is distinct from 'in_progress'
       or old.status::text is not distinct from 'in_progress' then
      return new;
    end if;

    perform public.sjelle_assert_driver_job_readiness(
      new.driver_id,
      'ride',
      new.vehicle_type
    );
  elsif tg_table_name = 'sjelle_delivery_jobs' then
    if new.status::text is distinct from 'in_progress'
       or old.status::text is not distinct from 'in_progress' then
      return new;
    end if;

    perform public.sjelle_assert_driver_job_readiness(
      new.driver_id,
      'delivery',
      null
    );
  else
    raise exception using errcode = 'P0001', message = 'UNSUPPORTED_DRIVER_READINESS_TABLE';
  end if;

  return new;
end;
$function$;

comment on function public.sjelle_guard_verified_driver_before_trip_start() is
  'Sjelle-only trigger guard that revalidates the driver before a ride starts or courier pickup is recorded.';

revoke all on function public.sjelle_assert_driver_job_readiness(uuid, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.sjelle_guard_verified_driver_before_trip_start()
  from public, anon, authenticated, service_role;

drop trigger if exists sjelle_guard_verified_driver_before_ride_start on public.sjelle_rides;
create trigger sjelle_guard_verified_driver_before_ride_start
before update of status on public.sjelle_rides
for each row execute function public.sjelle_guard_verified_driver_before_trip_start();

drop trigger if exists sjelle_guard_verified_driver_before_delivery_pickup on public.sjelle_delivery_jobs;
create trigger sjelle_guard_verified_driver_before_delivery_pickup
before update of status on public.sjelle_delivery_jobs
for each row execute function public.sjelle_guard_verified_driver_before_trip_start();
