CREATE OR REPLACE FUNCTION public.sjelle_offer_next_driver(p_job_kind text, p_job_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_city_id uuid;
  v_lat double precision;
  v_lon double precision;
  v_vehicle_type text;
  v_driver_id uuid;
  v_offer_id uuid;
begin
  if p_job_kind not in ('ride','delivery') then raise exception using errcode='P0001', message='INVALID_JOB_KIND'; end if;
  if p_job_kind='ride' then
    select city_id,pickup_lat,pickup_lon,vehicle_type into v_city_id,v_lat,v_lon,v_vehicle_type
    from public.sjelle_rides where id=p_job_id and status='searching';
  else
    select o.city_id,j.pickup_lat,j.pickup_lon,null::text into v_city_id,v_lat,v_lon,v_vehicle_type
    from public.sjelle_delivery_jobs j join public.sjelle_food_orders o on o.id=j.order_id
    where j.id=p_job_id and j.status='searching' and o.status not in ('submitted','rejected','cancelled','delivered','delivery_failed');
  end if;
  if v_city_id is null then return jsonb_build_object('offered',false,'reason','JOB_NOT_SEARCHABLE'); end if;

  update public.sjelle_driver_offers set status='expired'
  where job_kind=p_job_kind and status='offered' and expires_at<=now()
    and ((p_job_kind='ride' and ride_id=p_job_id) or (p_job_kind='delivery' and delivery_job_id=p_job_id));

  select d.user_id into v_driver_id
  from public.sjelle_driver_profiles d
  join public.sjelle_driver_locations l on l.driver_id=d.user_id
  where d.review_status='approved' and d.online and d.city_id=v_city_id
    and d.selected_mode=case when p_job_kind='ride' then 'ride'::public.sjelle_driver_mode else 'delivery'::public.sjelle_driver_mode end
    and l.recorded_at >= now()-interval '2 minutes'
    and exists (
      select 1 from public.sjelle_vehicles v
      where v.driver_id=d.user_id and v.review_status='approved'
        and (v.document_expires_at is null or v.document_expires_at>=current_date)
        and (p_job_kind='delivery' or v.vehicle_type=v_vehicle_type)
    )
    and not exists (
      select 1 from public.sjelle_driver_documents doc
      where doc.driver_id=d.user_id and doc.document_type in ('identity','driving_licence','vehicle_registration','insurance')
        and (doc.review_status<>'approved' or (doc.expires_at is not null and doc.expires_at<current_date))
    )
    and (
      select count(distinct doc.document_type) from public.sjelle_driver_documents doc
      where doc.driver_id=d.user_id and doc.document_type in ('identity','driving_licence','vehicle_registration','insurance')
        and doc.review_status='approved' and (doc.expires_at is null or doc.expires_at>=current_date)
    )=4
    and not exists (
      select 1 from public.sjelle_driver_offers old
      where old.driver_id=d.user_id and old.job_kind=p_job_kind
        and ((p_job_kind='ride' and old.ride_id=p_job_id) or (p_job_kind='delivery' and old.delivery_job_id=p_job_id))
    )
    and not exists (
      select 1 from public.sjelle_driver_offers pending
      where pending.driver_id=d.user_id and pending.status='offered' and pending.expires_at>now()
    )
    and not exists (
      select 1 from public.sjelle_rides r where r.driver_id=d.user_id
        and r.status in ('driver_assigned','driver_arriving','driver_arrived','in_progress')
    )
    and not exists (
      select 1 from public.sjelle_delivery_jobs j where j.driver_id=d.user_id
        and j.status in ('assigned','arriving','arrived','in_progress')
    )
  order by (6371000 * acos(least(1.0,greatest(-1.0,
    sin(radians(v_lat))*sin(radians(l.latitude))+
    cos(radians(v_lat))*cos(radians(l.latitude))*cos(radians(l.longitude-v_lon))
  )))) asc
  limit 1 for update of d skip locked;

  if v_driver_id is null then return jsonb_build_object('offered',false,'reason','NO_ELIGIBLE_DRIVER'); end if;
  insert into public.sjelle_driver_offers(driver_id,job_kind,ride_id,delivery_job_id,status,expires_at)
  values (v_driver_id,p_job_kind,case when p_job_kind='ride' then p_job_id else null end,
    case when p_job_kind='delivery' then p_job_id else null end,'offered',now()+interval '45 seconds')
  returning id into v_offer_id;
  return jsonb_build_object('offered',true,'offer_id',v_offer_id,'driver_id',v_driver_id,'expires_in_seconds',45);
end;
$function$
;
revoke all on function public.sjelle_offer_next_driver(text,uuid) from public,anon,authenticated;
grant execute on function public.sjelle_offer_next_driver(text,uuid) to service_role;
