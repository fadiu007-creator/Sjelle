-- Withdraw an outstanding driver offer if the relevant city service is switched off before acceptance.
CREATE OR REPLACE FUNCTION public.sjelle_respond_driver_offer(p_driver_id uuid, p_offer_id uuid, p_response text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_offer public.sjelle_driver_offers%rowtype;
  v_ride public.sjelle_rides%rowtype;
  v_job public.sjelle_delivery_jobs%rowtype;
  v_order public.sjelle_food_orders%rowtype;
  v_next jsonb;
  v_city_id uuid;
begin
  if p_response not in ('accept','reject') then raise exception using errcode='P0001',message='INVALID_OFFER_RESPONSE'; end if;
  select * into v_offer from public.sjelle_driver_offers where id=p_offer_id and driver_id=p_driver_id for update;
  if not found then raise exception using errcode='P0001',message='OFFER_NOT_FOUND'; end if;
  if v_offer.status<>'offered' then
    raise exception using errcode='P0001',message='OFFER_EXPIRED';
  end if;
  if v_offer.expires_at<=now() then
    update public.sjelle_driver_offers set status='expired' where id=v_offer.id and status='offered';
    v_next := public.sjelle_offer_next_driver(v_offer.job_kind,coalesce(v_offer.ride_id,v_offer.delivery_job_id));
    return jsonb_build_object('status','expired','next_driver_offered',coalesce((v_next->>'offered')::boolean,false));
  end if;
  if not exists(select 1 from public.sjelle_driver_profiles d where d.user_id=p_driver_id and d.review_status='approved' and d.online
    and d.selected_mode=case when v_offer.job_kind='ride' then 'ride'::public.sjelle_driver_mode else 'delivery'::public.sjelle_driver_mode end) then
    raise exception using errcode='P0001',message='DRIVER_NOT_AVAILABLE';
  end if;

  if p_response='reject' then
    update public.sjelle_driver_offers set status='rejected' where id=v_offer.id;
    v_next := public.sjelle_offer_next_driver(v_offer.job_kind,coalesce(v_offer.ride_id,v_offer.delivery_job_id));
    return jsonb_build_object('status','rejected','next_driver_offered',coalesce((v_next->>'offered')::boolean,false));
  end if;

  if v_offer.job_kind='ride' then
    select city_id into v_city_id from public.sjelle_rides where id=v_offer.ride_id and status='searching';
    if not exists(select 1 from public.sjelle_cities c where c.id=v_city_id and c.active and c.rides_enabled) then
      update public.sjelle_driver_offers set status='withdrawn' where id=v_offer.id;
      return jsonb_build_object('status','city_unavailable');
    end if;
  else
    select o.city_id into v_city_id
    from public.sjelle_delivery_jobs j join public.sjelle_food_orders o on o.id=j.order_id
    where j.id=v_offer.delivery_job_id and j.status='searching'
      and o.status not in ('submitted','rejected','cancelled','delivered','delivery_failed');
    if not exists(select 1 from public.sjelle_cities c where c.id=v_city_id and c.active and c.food_enabled) then
      update public.sjelle_driver_offers set status='withdrawn' where id=v_offer.id;
      return jsonb_build_object('status','city_unavailable');
    end if;
  end if;

  if v_offer.job_kind='ride' then
    select * into v_ride from public.sjelle_rides where id=v_offer.ride_id and status='searching' for update;
    if not found then raise exception using errcode='P0001',message='JOB_NOT_AVAILABLE'; end if;
    update public.sjelle_rides set driver_id=p_driver_id,status='driver_assigned',accepted_at=now() where id=v_ride.id;
    update public.sjelle_driver_offers set status='accepted' where id=v_offer.id;
    update public.sjelle_driver_offers set status='withdrawn' where ride_id=v_ride.id and id<>v_offer.id and status='offered';
    insert into public.sjelle_ride_events(ride_id,actor_id,event_type,event_data)
      values(v_ride.id,p_driver_id,'driver.assigned',jsonb_build_object('driver_id',p_driver_id,'offer_id',v_offer.id));
    insert into public.sjelle_audit_logs(actor_id,action,target_type,target_id,metadata)
      values(p_driver_id,'ride.offer.accepted','ride',v_ride.id::text,jsonb_build_object('offer_id',v_offer.id));
    return jsonb_build_object('status','accepted','job_kind','ride','job_id',v_ride.id);
  end if;

  select * into v_job from public.sjelle_delivery_jobs where id=v_offer.delivery_job_id and status='searching' for update;
  if not found then raise exception using errcode='P0001',message='JOB_NOT_AVAILABLE'; end if;
  update public.sjelle_delivery_jobs set driver_id=p_driver_id,status='assigned',assigned_at=now() where id=v_job.id;
  update public.sjelle_food_orders set status=case when status='ready_for_pickup' then 'courier_assigned'::public.sjelle_food_order_status else status end,updated_at=now()
    where id=v_job.order_id and status in ('accepted','preparing','ready_for_pickup');
  update public.sjelle_driver_offers set status='accepted' where id=v_offer.id;
  update public.sjelle_driver_offers set status='withdrawn' where delivery_job_id=v_job.id and id<>v_offer.id and status='offered';
  insert into public.sjelle_audit_logs(actor_id,action,target_type,target_id,metadata)
    values(p_driver_id,'delivery.offer.accepted','delivery_job',v_job.id::text,jsonb_build_object('offer_id',v_offer.id,'order_id',v_job.order_id));
  return jsonb_build_object('status','accepted','job_kind','delivery','job_id',v_job.id);
end;
$function$
;
revoke all on function public.sjelle_respond_driver_offer(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.sjelle_respond_driver_offer(uuid,uuid,text) to service_role;
