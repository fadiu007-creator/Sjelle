CREATE OR REPLACE FUNCTION public.sjelle_cancel_ride(p_customer_id uuid, p_ride_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare v_ride public.sjelle_rides%rowtype;
begin
  update public.sjelle_rides set status='cancelled_by_customer',cancelled_at=now(),updated_at=now()
   where id=p_ride_id and customer_id=p_customer_id and status='searching'
   returning * into v_ride;
  if not found then
    if exists(select 1 from public.sjelle_rides where id=p_ride_id and customer_id=p_customer_id) then
      raise exception using errcode='P0001',message='RIDE_NOT_CANCELLABLE';
    end if;
    raise exception using errcode='P0001',message='RIDE_NOT_FOUND';
  end if;
  update public.sjelle_driver_offers set status='withdrawn' where ride_id=v_ride.id and status='offered';
  insert into public.sjelle_ride_events(ride_id,actor_id,event_type,event_data)
    values(v_ride.id,p_customer_id,'ride.cancelled',jsonb_build_object('reason','customer_cancelled'));
  insert into public.sjelle_audit_logs(actor_id,action,target_type,target_id)
    values(p_customer_id,'ride.cancelled','ride',v_ride.id::text);
  return jsonb_build_object('id',v_ride.id,'status',v_ride.status);
end;
$function$
;
revoke all on function public.sjelle_cancel_ride(uuid,uuid) from public,anon,authenticated;
grant execute on function public.sjelle_cancel_ride(uuid,uuid) to service_role;
