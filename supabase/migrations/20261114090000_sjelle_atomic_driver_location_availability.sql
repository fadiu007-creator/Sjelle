-- Keep precise driver GPS updates tied to an explicit online transition.
-- Going online writes the fresh GPS fix and availability in one database transaction.
-- Going offline removes the stored precise location in that same transaction.

create or replace function public.sjelle_set_driver_availability(
  p_driver_id uuid,
  p_online boolean,
  p_mode text
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_profile public.sjelle_driver_profiles%rowtype;
  v_approved_document_count integer;
begin
  if p_mode not in ('ride','delivery') then
    raise exception using errcode='P0001', message='INVALID_AVAILABILITY';
  end if;

  select * into v_profile
  from public.sjelle_driver_profiles
  where user_id = p_driver_id
  for update;

  if not found then
    raise exception using errcode='P0001', message='DRIVER_APPLICATION_REQUIRED';
  end if;

  if p_online and v_profile.review_status <> 'approved' then
    raise exception using errcode='P0001', message='DRIVER_NOT_APPROVED';
  end if;

  if p_online then
    select count(*) into v_approved_document_count
    from (
      select distinct on (document_type)
        document_type, review_status, expires_at
      from public.sjelle_driver_documents
      where driver_id = p_driver_id
        and document_type in ('identity','driving_licence','vehicle_registration','insurance')
      order by document_type, created_at desc
    ) latest
    where review_status = 'approved'
      and (expires_at is null or expires_at >= current_date);

    if v_approved_document_count <> 4 then
      raise exception using errcode='P0001', message='DRIVER_DOCUMENTS_NOT_APPROVED';
    end if;

    if not exists (
      select 1
      from public.sjelle_vehicles
      where driver_id = p_driver_id
        and review_status = 'approved'
        and (document_expires_at is null or document_expires_at >= current_date)
    ) then
      raise exception using errcode='P0001', message='DRIVER_VEHICLE_NOT_APPROVED';
    end if;

    if not exists (
      select 1
      from public.sjelle_cities
      where id = v_profile.city_id
        and active
        and case when p_mode = 'ride' then rides_enabled else food_enabled end
    ) then
      raise exception using errcode='P0001', message='CITY_SERVICE_UNAVAILABLE';
    end if;

    if not exists (
      select 1
      from public.sjelle_driver_locations
      where driver_id = p_driver_id
        and recorded_at >= now() - interval '2 minutes'
    ) then
      raise exception using errcode='P0001', message='DRIVER_LOCATION_REQUIRED';
    end if;
  end if;

  if (not p_online or p_mode is distinct from v_profile.selected_mode::text) and (
    exists (
      select 1 from public.sjelle_rides r
      where r.driver_id=p_driver_id
        and r.status in ('driver_assigned','driver_arriving','driver_arrived','in_progress')
    ) or exists (
      select 1 from public.sjelle_delivery_jobs j
      where j.driver_id=p_driver_id
        and j.status in ('assigned','arriving','arrived','in_progress')
    )
  ) then
    raise exception using errcode='P0001', message='DRIVER_HAS_ACTIVE_JOB';
  end if;

  update public.sjelle_driver_profiles
  set online=p_online,
      selected_mode=p_mode::public.sjelle_driver_mode,
      updated_at=now()
  where user_id=p_driver_id
  returning * into v_profile;

  if not p_online then
    delete from public.sjelle_driver_locations
    where driver_id=p_driver_id;
  end if;

  return jsonb_build_object(
    'user_id', v_profile.user_id,
    'online', v_profile.online,
    'selected_mode', v_profile.selected_mode,
    'review_status', v_profile.review_status,
    'city_id', v_profile.city_id,
    'updated_at', v_profile.updated_at
  );
end;
$function$;

-- This overload accepts a GPS fix and delegates to the existing readiness/locking
-- function. If any readiness or active-job check fails, PostgreSQL rolls back the
-- location upsert together with the failed availability transition.
create or replace function public.sjelle_set_driver_availability_with_location(
  p_driver_id uuid,
  p_online boolean,
  p_mode text,
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy_m real
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
begin
  if p_online then
    if p_latitude is null and p_longitude is null and p_accuracy_m is null then
      null;
    elsif p_latitude is null or p_longitude is null or p_accuracy_m is null then
      raise exception using errcode='P0001', message='INVALID_LOCATION';
    elsif p_latitude < 41.7 or p_latitude > 43.4 or p_longitude < 19.7 or p_longitude > 22.0 then
      raise exception using errcode='P0001', message='INVALID_LOCATION';
    elsif p_accuracy_m < 0 or p_accuracy_m > 1500 then
      raise exception using errcode='P0001', message='GPS_ACCURACY_TOO_LOW';
    else
      insert into public.sjelle_driver_locations (
        driver_id, latitude, longitude, accuracy_m, heading_degrees, recorded_at, updated_at
      ) values (
        p_driver_id, p_latitude, p_longitude, p_accuracy_m, null, now(), now()
      )
      on conflict (driver_id) do update
      set latitude=excluded.latitude,
          longitude=excluded.longitude,
          accuracy_m=excluded.accuracy_m,
          heading_degrees=null,
          recorded_at=now(),
          updated_at=now();
    end if;
  elsif p_latitude is not null or p_longitude is not null or p_accuracy_m is not null then
    raise exception using errcode='P0001', message='INVALID_AVAILABILITY_LOCATION';
  end if;

  return public.sjelle_set_driver_availability(p_driver_id, p_online, p_mode);
end;
$function$;

revoke all on function public.sjelle_set_driver_availability_with_location(uuid, boolean, text, double precision, double precision, real) from public, anon, authenticated;
grant execute on function public.sjelle_set_driver_availability_with_location(uuid, boolean, text, double precision, double precision, real) to service_role;


-- Live GPS refreshes also lock the driver profile so an update cannot race an
-- offline transition and recreate a location row after the offline cleanup.
create or replace function public.sjelle_update_driver_location_if_online(
  p_driver_id uuid,
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy_m real,
  p_heading_degrees real
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_profile public.sjelle_driver_profiles%rowtype;
begin
  select * into v_profile
  from public.sjelle_driver_profiles
  where user_id = p_driver_id
  for update;

  if not found then
    raise exception using errcode='P0001', message='DRIVER_APPLICATION_REQUIRED';
  end if;
  if v_profile.review_status <> 'approved' then
    raise exception using errcode='P0001', message='DRIVER_NOT_APPROVED';
  end if;
  if not v_profile.online then
    raise exception using errcode='P0001', message='DRIVER_OFFLINE';
  end if;
  if p_latitude is null or p_longitude is null
    or p_latitude < 41.7 or p_latitude > 43.4
    or p_longitude < 19.7 or p_longitude > 22.0 then
    raise exception using errcode='P0001', message='INVALID_LOCATION';
  end if;
  if p_accuracy_m is null or p_accuracy_m < 0 or p_accuracy_m > 1500 then
    raise exception using errcode='P0001', message='GPS_ACCURACY_TOO_LOW';
  end if;
  if p_heading_degrees is not null and (p_heading_degrees < 0 or p_heading_degrees >= 360) then
    raise exception using errcode='P0001', message='INVALID_LOCATION';
  end if;

  insert into public.sjelle_driver_locations (
    driver_id, latitude, longitude, accuracy_m, heading_degrees, recorded_at, updated_at
  ) values (
    p_driver_id, p_latitude, p_longitude, p_accuracy_m, p_heading_degrees, now(), now()
  )
  on conflict (driver_id) do update
  set latitude=excluded.latitude,
      longitude=excluded.longitude,
      accuracy_m=excluded.accuracy_m,
      heading_degrees=excluded.heading_degrees,
      recorded_at=now(),
      updated_at=now();

  return jsonb_build_object('recorded', true, 'recorded_at', now());
end;
$function$;

revoke all on function public.sjelle_update_driver_location_if_online(uuid, double precision, double precision, real, real) from public, anon, authenticated;
grant execute on function public.sjelle_update_driver_location_if_online(uuid, double precision, double precision, real, real) to service_role;
