-- Revalidate full driver eligibility at the database assignment boundary.
-- Dispatch eligibility can change between offer creation and acceptance. Both ride
-- and delivery assignment triggers call this function, so a stale offer cannot
-- assign a driver whose documents, vehicle, GPS, city service or mode is no longer valid.

create or replace function public.sjelle_guard_driver_assignment()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_profile public.sjelle_driver_profiles%rowtype;
  v_driver_id uuid;
  v_mode text;
  v_city_id uuid;
  v_vehicle_type text;
  v_approved_document_count integer;
begin
  if tg_op = 'UPDATE' and old.driver_id is not distinct from new.driver_id then
    return new;
  end if;

  v_driver_id := new.driver_id;
  if v_driver_id is null then
    return new;
  end if;

  if tg_table_name = 'sjelle_rides' then
    v_mode := 'ride';
    v_city_id := new.city_id;
    v_vehicle_type := new.vehicle_type;
  else
    v_mode := 'delivery';
    select o.city_id into v_city_id
    from public.sjelle_food_orders o
    where o.id = new.order_id;
  end if;

  -- This row lock serializes assignment against driver availability and mode changes.
  select * into v_profile
  from public.sjelle_driver_profiles
  where user_id = v_driver_id
  for update;

  if not found
     or v_profile.review_status <> 'approved'
     or not v_profile.online
     or v_profile.selected_mode::text <> v_mode
     or v_profile.city_id is distinct from v_city_id then
    raise exception using errcode = 'P0001', message = 'DRIVER_NOT_AVAILABLE';
  end if;

  if not exists (
    select 1
    from public.sjelle_cities c
    where c.id = v_city_id
      and c.active
      and case when v_mode = 'ride' then c.rides_enabled else c.food_enabled end
  ) then
    raise exception using errcode = 'P0001', message = 'CITY_SERVICE_UNAVAILABLE';
  end if;

  -- Re-check the latest record for every mandatory document, not any older
  -- approved record. A newer rejected/pending/expired upload must block assignment.
  select count(*) into v_approved_document_count
  from (
    select distinct on (document_type)
      document_type, review_status, expires_at
    from public.sjelle_driver_documents
    where driver_id = v_driver_id
      and document_type in ('identity', 'driving_licence', 'vehicle_registration', 'insurance')
    order by document_type, created_at desc, id desc
  ) latest
  where latest.review_status = 'approved'
    and (latest.expires_at is null or latest.expires_at >= current_date);

  if v_approved_document_count <> 4 then
    raise exception using errcode = 'P0001', message = 'DRIVER_DOCUMENTS_NOT_APPROVED';
  end if;

  if tg_table_name = 'sjelle_rides' then
    if not exists (
      select 1
      from public.sjelle_vehicles v
      where v.driver_id = v_driver_id
        and v.vehicle_type = v_vehicle_type
        and v.review_status = 'approved'
        and (v.document_expires_at is null or v.document_expires_at >= current_date)
    ) then
      raise exception using errcode = 'P0001', message = 'DRIVER_VEHICLE_NOT_APPROVED';
    end if;
  else
    if not exists (
      select 1
      from public.sjelle_vehicles v
      where v.driver_id = v_driver_id
        and v.review_status = 'approved'
        and (v.document_expires_at is null or v.document_expires_at >= current_date)
    ) then
      raise exception using errcode = 'P0001', message = 'DRIVER_VEHICLE_NOT_APPROVED';
    end if;
  end if;

  if not exists (
    select 1
    from public.sjelle_driver_locations l
    where l.driver_id = v_driver_id
      and l.recorded_at >= now() - interval '2 minutes'
      and l.accuracy_m <= 1500
  ) then
    raise exception using errcode = 'P0001', message = 'DRIVER_LOCATION_REQUIRED';
  end if;

  -- One driver may have at most one active ride or delivery at a time.
  if tg_table_name = 'sjelle_rides' then
    if exists (
      select 1 from public.sjelle_rides r
      where r.driver_id = v_driver_id and r.id <> new.id
        and r.status in ('driver_assigned', 'driver_arriving', 'driver_arrived', 'in_progress')
    ) or exists (
      select 1 from public.sjelle_delivery_jobs j
      where j.driver_id = v_driver_id
        and j.status in ('assigned', 'arriving', 'arrived', 'in_progress')
    ) then
      raise exception using errcode = 'P0001', message = 'DRIVER_HAS_ACTIVE_JOB';
    end if;
  else
    if exists (
      select 1 from public.sjelle_rides r
      where r.driver_id = v_driver_id
        and r.status in ('driver_assigned', 'driver_arriving', 'driver_arrived', 'in_progress')
    ) or exists (
      select 1 from public.sjelle_delivery_jobs j
      where j.driver_id = v_driver_id and j.id <> new.id
        and j.status in ('assigned', 'arriving', 'arrived', 'in_progress')
    ) then
      raise exception using errcode = 'P0001', message = 'DRIVER_HAS_ACTIVE_JOB';
    end if;
  end if;

  return new;
end;
$function$;

revoke all on function public.sjelle_guard_driver_assignment() from public, anon, authenticated;
grant execute on function public.sjelle_guard_driver_assignment() to service_role;
