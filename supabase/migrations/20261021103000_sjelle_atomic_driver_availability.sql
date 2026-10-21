-- Serialize driver availability changes against dispatch assignment.
-- Every assignment locks the driver's profile and verifies that the driver is
-- still online and has no other active job. Availability changes use the same lock.

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

  if (not p_online or p_mode is distinct from v_profile.selected_mode) and (
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
  set online=p_online, selected_mode=p_mode, updated_at=now()
  where user_id=p_driver_id
  returning * into v_profile;

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
  else
    v_mode := 'delivery';
  end if;

  select * into v_profile
  from public.sjelle_driver_profiles
  where user_id=v_driver_id
  for update;

  if not found or v_profile.review_status <> 'approved'
     or not v_profile.online
     or v_profile.selected_mode::text <> v_mode then
    raise exception using errcode='P0001', message='DRIVER_NOT_AVAILABLE';
  end if;

  if tg_table_name = 'sjelle_rides' then
    if exists (
      select 1 from public.sjelle_rides r
      where r.driver_id=v_driver_id and r.id<>new.id
        and r.status in ('driver_assigned','driver_arriving','driver_arrived','in_progress')
    ) or exists (
      select 1 from public.sjelle_delivery_jobs j
      where j.driver_id=v_driver_id
        and j.status in ('assigned','arriving','arrived','in_progress')
    ) then
      raise exception using errcode='P0001', message='DRIVER_HAS_ACTIVE_JOB';
    end if;
  else
    if exists (
      select 1 from public.sjelle_rides r
      where r.driver_id=v_driver_id
        and r.status in ('driver_assigned','driver_arriving','driver_arrived','in_progress')
    ) or exists (
      select 1 from public.sjelle_delivery_jobs j
      where j.driver_id=v_driver_id and j.id<>new.id
        and j.status in ('assigned','arriving','arrived','in_progress')
    ) then
      raise exception using errcode='P0001', message='DRIVER_HAS_ACTIVE_JOB';
    end if;
  end if;

  return new;
end;
$function$;

revoke all on function public.sjelle_guard_driver_assignment() from public, anon, authenticated;

drop trigger if exists sjelle_guard_ride_driver_assignment on public.sjelle_rides;
create trigger sjelle_guard_ride_driver_assignment
before insert or update of driver_id on public.sjelle_rides
for each row execute function public.sjelle_guard_driver_assignment();

drop trigger if exists sjelle_guard_delivery_driver_assignment on public.sjelle_delivery_jobs;
create trigger sjelle_guard_delivery_driver_assignment
before insert or update of driver_id on public.sjelle_delivery_jobs
for each row execute function public.sjelle_guard_driver_assignment();
