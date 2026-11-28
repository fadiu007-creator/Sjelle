-- Keep dispatch availability consistent with the latest driver evidence.
-- Withdraw offers as soon as readiness is lost. Preserve location for an already
-- assigned/in-progress job, then take the driver offline after that job becomes terminal.

create or replace function public.sjelle_reconcile_driver_dispatch_after_readiness_change(
  p_driver_id uuid,
  p_force_withdraw boolean
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_profile public.sjelle_driver_profiles%rowtype;
  v_valid_document_count bigint := 0;
  v_has_approved_vehicle boolean := false;
  v_has_active_job boolean := false;
  v_has_location boolean := false;
  v_ready boolean := false;
begin
  if p_driver_id is null then
    return;
  end if;

  select *
    into v_profile
    from public.sjelle_driver_profiles
   where user_id = p_driver_id
   for update;

  if not found then
    return;
  end if;

  v_ready := v_profile.review_status::text = 'approved';

  if v_ready then
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
     where review_status::text = 'approved'
       and (expires_at is null or expires_at >= current_date);

    v_ready := v_valid_document_count = 4;
  end if;

  if v_ready then
    select exists (
      select 1
        from public.sjelle_vehicles
       where driver_id = p_driver_id
         and review_status::text = 'approved'
         and (document_expires_at is null or document_expires_at >= current_date)
    )
    into v_has_approved_vehicle;

    v_ready := v_has_approved_vehicle;
  end if;

  select exists (
    select 1
      from public.sjelle_rides
     where driver_id = p_driver_id
       and status::text in ('driver_assigned', 'driver_arriving', 'driver_arrived', 'in_progress')
    union all
    select 1
      from public.sjelle_delivery_jobs
     where driver_id = p_driver_id
       and status::text in ('assigned', 'arriving', 'arrived', 'in_progress')
  )
  into v_has_active_job;

  if not v_ready or p_force_withdraw then
    update public.sjelle_driver_offers
       set status = 'withdrawn'
     where driver_id = p_driver_id
       and status = 'offered';
  end if;

  -- Do not remove GPS while an assigned or started job still needs live tracking.
  -- Once the last active job becomes terminal, its status trigger calls this helper
  -- again and the existing profile privacy trigger purges the precise location.
  if not v_ready and not v_has_active_job then
    select exists (
      select 1
        from public.sjelle_driver_locations
       where driver_id = p_driver_id
    )
    into v_has_location;

    if v_profile.online or v_has_location then
      update public.sjelle_driver_profiles
         set online = false,
             updated_at = now()
       where user_id = p_driver_id;
    end if;
  end if;
end;
$function$;

comment on function public.sjelle_reconcile_driver_dispatch_after_readiness_change(uuid, boolean) is
  'Withdraws pending Sjelle offers when driver evidence is no longer dispatch-ready; preserves live location for active jobs and takes the driver offline after the last active job ends.';

create or replace function public.sjelle_reconcile_dispatch_after_evidence_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_driver_ids uuid[];
  v_driver_id uuid;
begin
  if tg_op = 'INSERT' then
    v_driver_ids := array[new.driver_id];
  elsif tg_op = 'DELETE' then
    v_driver_ids := array[old.driver_id];
  else
    v_driver_ids := array[old.driver_id, new.driver_id];
  end if;

  for v_driver_id in
    select distinct ids.driver_id
      from unnest(v_driver_ids) as ids(driver_id)
     where ids.driver_id is not null
     order by ids.driver_id
  loop
    perform public.sjelle_reconcile_driver_dispatch_after_readiness_change(v_driver_id, false);
  end loop;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$function$;

create or replace function public.sjelle_reconcile_dispatch_after_profile_review()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if old.review_status is distinct from new.review_status then
    perform public.sjelle_reconcile_driver_dispatch_after_readiness_change(new.user_id, true);
  end if;
  return new;
end;
$function$;

create or replace function public.sjelle_reconcile_dispatch_after_job_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_driver_id uuid;
begin
  if tg_op = 'UPDATE'
     and old.status is not distinct from new.status
     and old.driver_id is not distinct from new.driver_id then
    return new;
  end if;

  for v_driver_id in
    select distinct ids.driver_id
      from unnest(array[old.driver_id, new.driver_id]) as ids(driver_id)
     where ids.driver_id is not null
     order by ids.driver_id
  loop
    perform public.sjelle_reconcile_driver_dispatch_after_readiness_change(v_driver_id, false);
  end loop;

  return new;
end;
$function$;

drop trigger if exists sjelle_reconcile_dispatch_after_document_change on public.sjelle_driver_documents;
create trigger sjelle_reconcile_dispatch_after_document_change
after insert or update or delete on public.sjelle_driver_documents
for each row execute function public.sjelle_reconcile_dispatch_after_evidence_change();

drop trigger if exists sjelle_reconcile_dispatch_after_vehicle_change on public.sjelle_vehicles;
create trigger sjelle_reconcile_dispatch_after_vehicle_change
after insert or update or delete on public.sjelle_vehicles
for each row execute function public.sjelle_reconcile_dispatch_after_evidence_change();

drop trigger if exists sjelle_reconcile_dispatch_after_profile_review on public.sjelle_driver_profiles;
create trigger sjelle_reconcile_dispatch_after_profile_review
after update of review_status on public.sjelle_driver_profiles
for each row execute function public.sjelle_reconcile_dispatch_after_profile_review();

drop trigger if exists sjelle_reconcile_dispatch_after_ride_change on public.sjelle_rides;
create trigger sjelle_reconcile_dispatch_after_ride_change
after update of status, driver_id on public.sjelle_rides
for each row execute function public.sjelle_reconcile_dispatch_after_job_change();

drop trigger if exists sjelle_reconcile_dispatch_after_delivery_change on public.sjelle_delivery_jobs;
create trigger sjelle_reconcile_dispatch_after_delivery_change
after update of status, driver_id on public.sjelle_delivery_jobs
for each row execute function public.sjelle_reconcile_dispatch_after_job_change();

revoke all on function public.sjelle_reconcile_driver_dispatch_after_readiness_change(uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function public.sjelle_reconcile_dispatch_after_evidence_change() from public, anon, authenticated, service_role;
revoke all on function public.sjelle_reconcile_dispatch_after_profile_review() from public, anon, authenticated, service_role;
revoke all on function public.sjelle_reconcile_dispatch_after_job_change() from public, anon, authenticated, service_role;
