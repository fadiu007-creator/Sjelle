-- Serialize go-online GPS writes with offline cleanup and live GPS refreshes.
-- All availability and location paths acquire the driver profile row lock first.
-- This avoids a location-row/profile-row lock inversion during concurrent transitions.

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
declare
  v_profile public.sjelle_driver_profiles%rowtype;
begin
  -- Match the lock order used by sjelle_set_driver_availability and
  -- sjelle_update_driver_location_if_online: profile first, location second.
  select * into v_profile
  from public.sjelle_driver_profiles
  where user_id = p_driver_id
  for update;

  if not found then
    raise exception using errcode='P0001', message='DRIVER_APPLICATION_REQUIRED';
  end if;

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

  -- The existing function reuses the already-held profile lock and performs
  -- the authoritative approval, document, vehicle, city, freshness and job checks.
  -- Any failure rolls back the GPS write in this transaction.
  return public.sjelle_set_driver_availability(p_driver_id, p_online, p_mode);
end;
$function$;

revoke all on function public.sjelle_set_driver_availability_with_location(uuid, boolean, text, double precision, double precision, real) from public, anon, authenticated;
grant execute on function public.sjelle_set_driver_availability_with_location(uuid, boolean, text, double precision, double precision, real) to service_role;
