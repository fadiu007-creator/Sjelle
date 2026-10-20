CREATE OR REPLACE FUNCTION public.sjelle_dispatch_waiting_jobs()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_ride record;
  v_job record;
  v_ride_checked integer := 0;
  v_delivery_checked integer := 0;
  v_offers_sent integer := 0;
  v_result jsonb;
begin
  update public.sjelle_driver_offers set status='expired' where status='offered' and expires_at<=now();

  for v_ride in
    select r.id from public.sjelle_rides r
    where r.status='searching'
      and not exists(select 1 from public.sjelle_driver_offers o where o.ride_id=r.id and o.status='offered' and o.expires_at>now())
    order by r.requested_at asc limit 100
  loop
    v_ride_checked := v_ride_checked+1;
    v_result := public.sjelle_offer_next_driver('ride',v_ride.id);
    if coalesce((v_result->>'offered')::boolean,false) then v_offers_sent := v_offers_sent+1; end if;
  end loop;

  for v_job in
    select j.id from public.sjelle_delivery_jobs j
    join public.sjelle_food_orders o on o.id=j.order_id
    where j.status='searching' and o.status not in ('submitted','rejected','cancelled','delivered','delivery_failed')
      and not exists(select 1 from public.sjelle_driver_offers d where d.delivery_job_id=j.id and d.status='offered' and d.expires_at>now())
    order by j.created_at asc limit 100
  loop
    v_delivery_checked := v_delivery_checked+1;
    v_result := public.sjelle_offer_next_driver('delivery',v_job.id);
    if coalesce((v_result->>'offered')::boolean,false) then v_offers_sent := v_offers_sent+1; end if;
  end loop;

  return jsonb_build_object('rides_checked',v_ride_checked,'deliveries_checked',v_delivery_checked,'offers_sent',v_offers_sent,'ran_at',now());
end;
$function$
;
revoke all on function public.sjelle_dispatch_waiting_jobs() from public,anon,authenticated;
grant execute on function public.sjelle_dispatch_waiting_jobs() to service_role;
