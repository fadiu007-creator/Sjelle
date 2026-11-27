-- Make every administrator driver/document/vehicle review atomic with its audit record.
-- Readiness is checked under the driver-profile lock so concurrent evidence changes
-- cannot slip between the approval decision and the persisted profile state.

create or replace function public.sjelle_admin_review_driver(
  p_actor_id uuid,
  p_driver_id uuid,
  p_review_status text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_profile public.sjelle_driver_profiles%rowtype;
  v_valid_document_count bigint;
begin
  if p_actor_id is null or not exists (
    select 1 from public.sjelle_user_roles
    where user_id = p_actor_id and role = 'admin'::public.sjelle_app_role
  ) then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  if p_driver_id is null or p_review_status is null
     or p_review_status not in ('approved', 'rejected', 'suspended') then
    raise exception using errcode = 'P0001', message = 'INVALID_REVIEW_STATUS';
  end if;

  select * into v_profile
  from public.sjelle_driver_profiles
  where user_id = p_driver_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'DRIVER_NOT_FOUND';
  end if;

  if p_review_status = 'approved' then
    with latest_documents as (
      select distinct on (document_type) document_type, review_status, expires_at
      from public.sjelle_driver_documents
      where driver_id = p_driver_id
        and document_type in ('identity', 'driving_licence', 'vehicle_registration', 'insurance')
      order by document_type, created_at desc, id desc
    )
    select count(*) into v_valid_document_count
    from latest_documents
    where review_status = 'approved'
      and (expires_at is null or expires_at >= current_date);
    if v_valid_document_count <> 4 then
      raise exception using errcode = 'P0001', message = 'DRIVER_DOCUMENTS_NOT_APPROVED';
    end if;
    if not exists (
      select 1 from public.sjelle_vehicles
      where driver_id = p_driver_id
        and review_status = 'approved'
        and (document_expires_at is null or document_expires_at >= current_date)
    ) then
      raise exception using errcode = 'P0001', message = 'DRIVER_VEHICLE_NOT_APPROVED';
    end if;
  end if;

  update public.sjelle_driver_profiles
  set review_status = p_review_status::public.sjelle_driver_review_status,
      approved_at = case when p_review_status = 'approved' then now() else null end,
      approved_by = case when p_review_status = 'approved' then p_actor_id else null end,
      online = false,
      updated_at = now()
  where user_id = p_driver_id
  returning * into v_profile;

  insert into public.sjelle_audit_logs (actor_id, action, target_type, target_id, metadata)
  values (
    p_actor_id, 'driver.reviewed', 'driver', p_driver_id::text,
    jsonb_build_object('review_status', p_review_status, 'online', false)
  );

  return jsonb_build_object('user_id', v_profile.user_id, 'review_status', v_profile.review_status, 'online', v_profile.online);
end;
$function$;

comment on function public.sjelle_admin_review_driver(uuid, uuid, text) is
  'Atomically reviews a Sjelle driver, revalidates mandatory evidence on approval, clears online state and records the audit event.';

create or replace function public.sjelle_admin_review_driver_document(
  p_actor_id uuid,
  p_document_id uuid,
  p_review_status text,
  p_rejection_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_driver_id uuid;
  v_document public.sjelle_driver_documents%rowtype;
  v_reason text;
begin
  if p_actor_id is null or not exists (
    select 1 from public.sjelle_user_roles
    where user_id = p_actor_id and role = 'admin'::public.sjelle_app_role
  ) then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  if p_document_id is null or p_review_status is null
     or p_review_status not in ('approved', 'rejected')
     or length(coalesce(p_rejection_reason, '')) > 300 then
    raise exception using errcode = 'P0001', message = 'INVALID_REVIEW_STATUS';
  end if;

  select driver_id into v_driver_id
  from public.sjelle_driver_documents
  where id = p_document_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'DOCUMENT_NOT_FOUND';
  end if;

  perform 1 from public.sjelle_driver_profiles
  where user_id = v_driver_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'DRIVER_NOT_FOUND';
  end if;

  select * into v_document
  from public.sjelle_driver_documents
  where id = p_document_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'DOCUMENT_NOT_FOUND';
  end if;
  if v_document.driver_id is distinct from v_driver_id then
    raise exception using errcode = '40001', message = 'DOCUMENT_OWNERSHIP_CHANGED';
  end if;
  if p_review_status = 'approved' and v_document.expires_at is not null
     and v_document.expires_at < current_date then
    raise exception using errcode = 'P0001', message = 'DOCUMENT_EXPIRED';
  end if;

  v_reason := case when p_review_status = 'rejected'
    then coalesce(nullif(btrim(p_rejection_reason), ''), 'Document rejected')
    else null end;

  update public.sjelle_driver_documents
  set review_status = p_review_status::public.sjelle_driver_review_status,
      reviewed_at = now(),
      reviewed_by = p_actor_id,
      rejection_reason = v_reason
  where id = p_document_id
  returning * into v_document;

  insert into public.sjelle_audit_logs (actor_id, action, target_type, target_id, reason, metadata)
  values (
    p_actor_id, 'driver_document.reviewed', 'driver_document', p_document_id::text,
    v_reason, jsonb_build_object('review_status', p_review_status, 'document_type', v_document.document_type)
  );

  return jsonb_build_object('id', v_document.id, 'document_type', v_document.document_type, 'review_status', v_document.review_status);
end;
$function$;

comment on function public.sjelle_admin_review_driver_document(uuid, uuid, text, text) is
  'Atomically reviews a Sjelle driver document and records its audit event under the shared driver-readiness lock.';

create or replace function public.sjelle_admin_review_vehicle(
  p_actor_id uuid,
  p_vehicle_id uuid,
  p_review_status text,
  p_document_expires_at date
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_driver_id uuid;
  v_vehicle public.sjelle_vehicles%rowtype;
begin
  if p_actor_id is null or not exists (
    select 1 from public.sjelle_user_roles
    where user_id = p_actor_id and role = 'admin'::public.sjelle_app_role
  ) then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  if p_vehicle_id is null or p_review_status is null
     or p_review_status not in ('approved', 'rejected') then
    raise exception using errcode = 'P0001', message = 'INVALID_REVIEW_STATUS';
  end if;
  if p_review_status = 'approved' and p_document_expires_at is not null
     and p_document_expires_at < current_date then
    raise exception using errcode = 'P0001', message = 'VEHICLE_DOCUMENT_EXPIRED';
  end if;

  select driver_id into v_driver_id
  from public.sjelle_vehicles
  where id = p_vehicle_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'VEHICLE_NOT_FOUND';
  end if;

  perform 1 from public.sjelle_driver_profiles
  where user_id = v_driver_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'DRIVER_NOT_FOUND';
  end if;

  select * into v_vehicle
  from public.sjelle_vehicles
  where id = p_vehicle_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'VEHICLE_NOT_FOUND';
  end if;
  if v_vehicle.driver_id is distinct from v_driver_id then
    raise exception using errcode = '40001', message = 'VEHICLE_OWNERSHIP_CHANGED';
  end if;

  update public.sjelle_vehicles
  set review_status = p_review_status::public.sjelle_driver_review_status,
      verified_at = case when p_review_status = 'approved' then now() else null end,
      verified_by = case when p_review_status = 'approved' then p_actor_id else null end,
      document_expires_at = p_document_expires_at
  where id = p_vehicle_id
  returning * into v_vehicle;

  insert into public.sjelle_audit_logs (actor_id, action, target_type, target_id, metadata)
  values (
    p_actor_id, 'vehicle.reviewed', 'vehicle', p_vehicle_id::text,
    jsonb_build_object('review_status', p_review_status, 'document_expires_at', p_document_expires_at)
  );

  return jsonb_build_object('id', v_vehicle.id, 'review_status', v_vehicle.review_status);
end;
$function$;

comment on function public.sjelle_admin_review_vehicle(uuid, uuid, text, date) is
  'Atomically reviews a Sjelle vehicle and records its audit event under the shared driver-readiness lock.';

revoke all on function public.sjelle_admin_review_driver(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.sjelle_admin_review_driver_document(uuid, uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.sjelle_admin_review_vehicle(uuid, uuid, text, date) from public, anon, authenticated, service_role;
grant execute on function public.sjelle_admin_review_driver(uuid, uuid, text) to service_role;
grant execute on function public.sjelle_admin_review_driver_document(uuid, uuid, text, text) to service_role;
grant execute on function public.sjelle_admin_review_vehicle(uuid, uuid, text, date) to service_role;
