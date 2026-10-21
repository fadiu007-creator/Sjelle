CREATE OR REPLACE FUNCTION public.sjelle_driver_update_job(
  p_driver_id uuid,
  p_job_kind text,
  p_job_id uuid,
  p_next_status text,
  p_cash_collected boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_ride public.sjelle_rides%rowtype;
  v_job public.sjelle_delivery_jobs%rowtype;
  v_order public.sjelle_food_orders%rowtype;
begin
  if not exists (select 1 from public.sjelle_driver_profiles where user_id=p_driver_id and review_status='approved') then
    raise exception using errcode='P0001', message='DRIVER_NOT_APPROVED';
  end if;

  if (p_job_kind='ride' and p_next_status='completed') or (p_job_kind='delivery' and p_next_status='delivered') then
    if p_cash_collected is distinct from true then
      raise exception using errcode='P0001', message='CASH_COLLECTION_CONFIRMATION_REQUIRED';
    end if;
  elsif p_cash_collected is true then
    raise exception using errcode='P0001', message='CASH_CONFIRMATION_ONLY_ON_COMPLETION';
  end if;

  if p_job_kind='ride' then
    select * into v_ride from public.sjelle_rides where id=p_job_id and driver_id=p_driver_id for update;
    if not found then raise exception using errcode='P0001', message='JOB_NOT_FOUND'; end if;
    if not (
      (v_ride.status='driver_assigned' and p_next_status='driver_arriving') or
      (v_ride.status='driver_arriving' and p_next_status='driver_arrived') or
      (v_ride.status='driver_arrived' and p_next_status='in_progress') or
      (v_ride.status='in_progress' and p_next_status='completed')
    ) then raise exception using errcode='P0001', message='INVALID_JOB_TRANSITION'; end if;
    update public.sjelle_rides set status=p_next_status::public.sjelle_ride_status,
      started_at=case when p_next_status='in_progress' then now() else started_at end,
      completed_at=case when p_next_status='completed' then now() else completed_at end,
      final_amount_cents=case when p_next_status='completed' then quoted_amount_cents else final_amount_cents end,
      sjelle_cash_status=case when p_next_status='completed' and p_cash_collected then 'collected'::public.sjelle_cash_status else sjelle_cash_status end
    where id=v_ride.id;
    insert into public.sjelle_ride_events(ride_id,actor_id,event_type,event_data)
      values(v_ride.id,p_driver_id,'ride.status_changed',jsonb_build_object('status',p_next_status,'cash_collected',p_cash_collected));
    insert into public.sjelle_audit_logs(actor_id,action,target_type,target_id,metadata)
      values(p_driver_id,'ride.status_changed','ride',v_ride.id::text,jsonb_build_object('status',p_next_status,'cash_collected',p_cash_collected));
    return jsonb_build_object('job_id',v_ride.id,'status',p_next_status);
  elsif p_job_kind='delivery' then
    select * into v_job from public.sjelle_delivery_jobs where id=p_job_id and driver_id=p_driver_id for update;
    if not found then raise exception using errcode='P0001', message='JOB_NOT_FOUND'; end if;
    select * into v_order from public.sjelle_food_orders where id=v_job.order_id for update;
    if p_next_status='arriving' and v_job.status='assigned' then
      update public.sjelle_delivery_jobs set status='arriving' where id=v_job.id;
    elsif p_next_status='arrived' and v_job.status='arriving' then
      update public.sjelle_delivery_jobs set status='arrived' where id=v_job.id;
    elsif p_next_status='picked_up' and v_job.status in ('assigned','arriving','arrived') then
      if v_order.ready_at is null or v_order.status not in ('ready_for_pickup','courier_assigned') then
        raise exception using errcode='P0001', message='ORDER_NOT_READY_FOR_PICKUP';
      end if;
      update public.sjelle_delivery_jobs set status='in_progress',picked_up_at=now() where id=v_job.id;
      update public.sjelle_food_orders set status='picked_up',picked_up_at=now(),updated_at=now() where id=v_order.id;
    elsif p_next_status='delivered' and v_job.status='in_progress' then
      update public.sjelle_delivery_jobs set status='completed',delivered_at=now() where id=v_job.id;
      update public.sjelle_food_orders set status='delivered',delivered_at=now(),updated_at=now(),
        sjelle_cash_status='collected'::public.sjelle_cash_status where id=v_order.id;
    else
      raise exception using errcode='P0001', message='INVALID_JOB_TRANSITION';
    end if;
    insert into public.sjelle_audit_logs(actor_id,action,target_type,target_id,metadata)
      values(p_driver_id,'delivery.status_changed','delivery_job',v_job.id::text,jsonb_build_object('status',p_next_status,'cash_collected',p_cash_collected));
    return jsonb_build_object('job_id',v_job.id,'status',p_next_status);
  else
    raise exception using errcode='P0001', message='INVALID_JOB_KIND';
  end if;
end;
$function$;

REVOKE ALL ON FUNCTION public.sjelle_driver_update_job(uuid, text, uuid, text, boolean) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sjelle_driver_update_job(uuid, text, uuid, text, boolean) TO service_role;
