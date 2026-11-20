-- Align the database online gate with dispatch eligibility and make offline GPS
-- cleanup unavoidable, including administrative review/suspension updates.

create index if not exists sjelle_driver_documents_latest_evidence_idx
  on public.sjelle_driver_documents (driver_id, document_type, created_at desc, id desc)
  where document_type in ('identity', 'driving_licence', 'vehicle_registration', 'insurance');

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
  if p_driver_id is null or p_online is null or p_mode is null or p_mode not in ('ride','delivery') then
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
      order by document_type, created_at desc, id desc
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
        and recorded_at <= now() + interval '15 seconds'
        and latitude between 41.7 and 43.4
        and longitude between 19.7 and 22.0
        and accuracy_m between 0 and 1500
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

revoke all on function public.sjelle_set_driver_availability(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.sjelle_set_driver_availability(uuid, boolean, text) to service_role;

-- Admin review routes update the profile directly. Enforce offline status for
-- every non-approved profile and delete its precise location in the same write.
create or replace function public.sjelle_enforce_driver_location_privacy()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
begin
  if new.review_status is distinct from 'approved' then
    new.online := false;
  end if;

  if not new.online then
    delete from public.sjelle_driver_locations
    where driver_id = new.user_id;
  end if;

  return new;
end;
$function$;

drop trigger if exists sjelle_enforce_driver_location_privacy on public.sjelle_driver_profiles;
create trigger sjelle_enforce_driver_location_privacy
before insert or update on public.sjelle_driver_profiles
for each row
execute function public.sjelle_enforce_driver_location_privacy();

revoke all on function public.sjelle_enforce_driver_location_privacy() from public, anon, authenticated;
grant execute on function public.sjelle_enforce_driver_location_privacy() to service_role;
