-- Sjelle private driver-document storage and dispatch workflows.
-- The only storage bucket created here is namespaced for Sjelle.

insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('sjelle-driver-documents','sjelle-driver-documents',false,10485760,array['application/pdf','image/jpeg','image/png'])
on conflict (id) do update set public=false,file_size_limit=10485760,allowed_mime_types=array['application/pdf','image/jpeg','image/png'];

CREATE OR REPLACE FUNCTION public.sjelle_handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
begin
  insert into public.sjelle_profiles(id, display_name, preferred_language)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), ''),
    case when new.raw_user_meta_data ->> 'preferred_language' in ('sq','en','sr')
      then new.raw_user_meta_data ->> 'preferred_language' else 'sq' end
  )
  on conflict (id) do nothing;
  insert into public.sjelle_user_roles(user_id, role)
  values (new.id, 'customer')
  on conflict (user_id, role) do nothing;
  return new;
end;
$function$


CREATE OR REPLACE FUNCTION public.sjelle_create_food_order(p_customer_id uuid, p_restaurant_id uuid, p_idempotency_key text, p_delivery_address_text text, p_delivery_lat double precision, p_delivery_lon double precision, p_delivery_instructions text, p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_existing public.sjelle_food_orders%rowtype;
  v_restaurant public.sjelle_restaurants%rowtype;
  v_city public.sjelle_cities%rowtype;
  v_pricing public.sjelle_city_pricing%rowtype;
  v_order public.sjelle_food_orders%rowtype;
  v_item record;
  v_menu_item public.sjelle_menu_items%rowtype;
  v_subtotal integer := 0;
  v_line_total integer;
  v_total integer;
  v_item_count integer;
begin
  if p_customer_id is null or p_restaurant_id is null then
    raise exception using errcode='P0001', message='INVALID_ORDER';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) < 12 or length(p_idempotency_key) > 128 then
    raise exception using errcode='P0001', message='INVALID_IDEMPOTENCY_KEY';
  end if;
  if p_delivery_address_text is null or length(trim(p_delivery_address_text)) < 4 or length(p_delivery_address_text) > 500 then
    raise exception using errcode='P0001', message='INVALID_DELIVERY_ADDRESS';
  end if;
  if p_delivery_lat is null or p_delivery_lat not between -90 and 90
     or p_delivery_lon is null or p_delivery_lon not between -180 and 180 then
    raise exception using errcode='P0001', message='INVALID_DELIVERY_COORDINATES';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 50 then
    raise exception using errcode='P0001', message='INVALID_ORDER_ITEMS';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_items) as x(id uuid, quantity integer)
    where x.id is null or x.quantity is null or x.quantity < 1 or x.quantity > 100
  ) or (select count(*) from jsonb_to_recordset(p_items) as x(id uuid, quantity integer))
      <> (select count(distinct x.id) from jsonb_to_recordset(p_items) as x(id uuid, quantity integer)) then
    raise exception using errcode='P0001', message='INVALID_ORDER_ITEMS';
  end if;

  select * into v_existing from public.sjelle_food_orders
   where customer_id=p_customer_id and idempotency_key=p_idempotency_key;
  if found then
    return jsonb_build_object('id',v_existing.id,'status',v_existing.status,'item_subtotal_cents',v_existing.item_subtotal_cents,
      'delivery_fee_cents',v_existing.delivery_fee_cents,'service_fee_cents',v_existing.service_fee_cents,
      'total_cents',v_existing.total_cents,'currency',v_existing.currency,'replayed',true);
  end if;

  select * into v_restaurant from public.sjelle_restaurants where id=p_restaurant_id for share;
  if not found or v_restaurant.approval_status <> 'approved' or not v_restaurant.is_open or not v_restaurant.delivery_enabled then
    raise exception using errcode='P0001', message='RESTAURANT_UNAVAILABLE';
  end if;
  select * into v_city from public.sjelle_cities where id=v_restaurant.city_id for share;
  if not found or not v_city.active or not v_city.food_enabled then
    raise exception using errcode='P0001', message='CITY_UNAVAILABLE';
  end if;
  select * into v_pricing from public.sjelle_city_pricing where city_id=v_city.id and active for share;
  if not found then
    raise exception using errcode='P0001', message='FOOD_PRICING_NOT_CONFIGURED';
  end if;

  for v_item in select * from jsonb_to_recordset(p_items) as x(id uuid, quantity integer) loop
    select * into v_menu_item from public.sjelle_menu_items
      where id=v_item.id and restaurant_id=v_restaurant.id and available for share;
    if not found then
      raise exception using errcode='P0001', message='MENU_ITEM_UNAVAILABLE';
    end if;
    v_line_total := v_menu_item.price_cents * v_item.quantity;
    if v_line_total > 2000000000 or v_subtotal > 2000000000 - v_line_total then
      raise exception using errcode='P0001', message='ORDER_TOTAL_TOO_LARGE';
    end if;
    v_subtotal := v_subtotal + v_line_total;
  end loop;
  if v_subtotal < v_pricing.food_minimum_subtotal_cents then
    raise exception using errcode='P0001', message='MINIMUM_ORDER_NOT_MET';
  end if;
  v_total := v_subtotal + v_pricing.food_delivery_fee_cents + v_pricing.food_service_fee_cents;
  if v_total > 2000000000 then raise exception using errcode='P0001', message='ORDER_TOTAL_TOO_LARGE'; end if;

  insert into public.sjelle_food_orders(
    customer_id, restaurant_id, city_id, delivery_address_text, delivery_lat, delivery_lon,
    delivery_instructions, status, payment_method, sjelle_cash_status, item_subtotal_cents,
    delivery_fee_cents, service_fee_cents, discount_cents, total_cents, currency,
    restaurant_commission_bps, prep_time_minutes, idempotency_key
  ) values (
    p_customer_id, v_restaurant.id, v_city.id, trim(p_delivery_address_text), p_delivery_lat, p_delivery_lon,
    nullif(trim(p_delivery_instructions), ''), 'submitted', 'cash', 'due', v_subtotal,
    v_pricing.food_delivery_fee_cents, v_pricing.food_service_fee_cents, 0, v_total, 'EUR',
    v_restaurant.commission_bps, v_restaurant.prep_time_minutes, p_idempotency_key
  ) returning * into v_order;

  for v_item in select * from jsonb_to_recordset(p_items) as x(id uuid, quantity integer) loop
    select * into v_menu_item from public.sjelle_menu_items where id=v_item.id and restaurant_id=v_restaurant.id and available;
    insert into public.sjelle_food_order_items(order_id, menu_item_id, item_name_snapshot, unit_price_cents, quantity, line_total_cents)
    values (v_order.id, v_menu_item.id, v_menu_item.name, v_menu_item.price_cents, v_item.quantity, v_menu_item.price_cents * v_item.quantity);
  end loop;

  insert into public.sjelle_audit_logs(actor_id, action, target_type, target_id, metadata)
  values (p_customer_id, 'food_order.created', 'food_order', v_order.id::text,
    jsonb_build_object('restaurant_id',v_restaurant.id,'total_cents',v_total,'currency','EUR'));

  return jsonb_build_object('id',v_order.id,'status',v_order.status,'item_subtotal_cents',v_order.item_subtotal_cents,
    'delivery_fee_cents',v_order.delivery_fee_cents,'service_fee_cents',v_order.service_fee_cents,
    'total_cents',v_order.total_cents,'currency',v_order.currency,'replayed',false);
end;
$function$


CREATE OR REPLACE FUNCTION public.sjelle_cancel_food_order(p_customer_id uuid, p_order_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare v_order public.sjelle_food_orders%rowtype;
begin
  update public.sjelle_food_orders
     set status='cancelled', cancelled_at=now(), cancellation_reason='customer_cancelled', updated_at=now()
   where id=p_order_id and customer_id=p_customer_id and status='submitted'
   returning * into v_order;
  if not found then
    if exists(select 1 from public.sjelle_food_orders where id=p_order_id and customer_id=p_customer_id) then
      raise exception using errcode='P0001', message='ORDER_NOT_CANCELLABLE';
    end if;
    raise exception using errcode='P0001', message='ORDER_NOT_FOUND';
  end if;
  insert into public.sjelle_audit_logs(actor_id, action, target_type, target_id)
  values (p_customer_id, 'food_order.cancelled', 'food_order', v_order.id::text);
  return jsonb_build_object('id',v_order.id,'status',v_order.status);
end;
$function$


CREATE OR REPLACE FUNCTION public.sjelle_update_food_order_status(p_actor_id uuid, p_order_id uuid, p_next_status text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_order public.sjelle_food_orders%rowtype;
  v_restaurant public.sjelle_restaurants%rowtype;
  v_job public.sjelle_delivery_jobs%rowtype;
  v_next public.sjelle_food_order_status;
begin
  if p_next_status not in ('accepted','preparing','ready_for_pickup','rejected') then
    raise exception using errcode='P0001', message='INVALID_ORDER_TRANSITION';
  end if;
  begin v_next := p_next_status::public.sjelle_food_order_status;
  exception when others then raise exception using errcode='P0001', message='INVALID_ORDER_TRANSITION'; end;
  select o.* into v_order from public.sjelle_food_orders o where o.id=p_order_id for update;
  if not found then raise exception using errcode='P0001', message='ORDER_NOT_FOUND'; end if;
  select * into v_restaurant from public.sjelle_restaurants where id=v_order.restaurant_id;
  if not found or not (v_restaurant.owner_id=p_actor_id or exists (
    select 1 from public.sjelle_restaurant_staff s where s.restaurant_id=v_restaurant.id and s.user_id=p_actor_id and s.can_manage_orders
  )) then raise exception using errcode='P0001', message='FORBIDDEN'; end if;
  if not (
    (v_order.status='submitted' and v_next in ('accepted','rejected')) or
    (v_order.status='accepted' and v_next='preparing') or
    (v_order.status='preparing' and v_next='ready_for_pickup') or
    (v_order.status='courier_assigned' and v_next='ready_for_pickup')
  ) then raise exception using errcode='P0001', message='INVALID_ORDER_TRANSITION'; end if;

  if v_order.status='courier_assigned' and v_next='ready_for_pickup' then
    update public.sjelle_food_orders set ready_at=now(),updated_at=now() where id=v_order.id returning * into v_order;
  else
    update public.sjelle_food_orders set status=v_next,
      accepted_at=case when v_next='accepted' then now() else accepted_at end,
      ready_at=case when v_next='ready_for_pickup' then now() else ready_at end,
      updated_at=now()
    where id=v_order.id returning * into v_order;
  end if;

  if v_next='accepted' then
    insert into public.sjelle_delivery_jobs(order_id,pickup_lat,pickup_lon,delivery_lat,delivery_lon,status)
    values (v_order.id,v_restaurant.latitude,v_restaurant.longitude,v_order.delivery_lat,v_order.delivery_lon,'searching')
    on conflict (order_id) do nothing
    returning * into v_job;
    if v_job.id is null then select * into v_job from public.sjelle_delivery_jobs where order_id=v_order.id; end if;
    perform public.sjelle_offer_next_driver('delivery',v_job.id);
  end if;
  insert into public.sjelle_audit_logs(actor_id, action, target_type, target_id, metadata)
  values (p_actor_id, 'food_order.status_changed', 'food_order', v_order.id::text, jsonb_build_object('status',v_order.status,'requested_status',v_next));
  return jsonb_build_object('id',v_order.id,'status',v_order.status);
end;
$function$


CREATE OR REPLACE FUNCTION public.sjelle_book_fixed_route_ride(p_customer_id uuid, p_route_id uuid, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_existing public.sjelle_rides%rowtype;
  v_route public.sjelle_fixed_route_prices%rowtype;
  v_city public.sjelle_cities%rowtype;
  v_ride public.sjelle_rides%rowtype;
  v_offer jsonb;
begin
  if p_customer_id is null or p_route_id is null or p_idempotency_key is null
    or length(p_idempotency_key) < 12 or length(p_idempotency_key) > 128 then
    raise exception using errcode='P0001', message='INVALID_RIDE_REQUEST';
  end if;
  select * into v_existing from public.sjelle_rides where customer_id=p_customer_id and idempotency_key=p_idempotency_key;
  if found then return jsonb_build_object('id',v_existing.id,'status',v_existing.status,'quoted_amount_cents',v_existing.quoted_amount_cents,'currency','EUR','replayed',true); end if;
  select * into v_route from public.sjelle_fixed_route_prices where id=p_route_id and active and effective_from<=now()
    and (effective_until is null or effective_until>now()) and origin_lat is not null and origin_lon is not null
    and destination_lat is not null and destination_lon is not null for share;
  if not found then raise exception using errcode='P0001', message='ROUTE_NOT_AVAILABLE'; end if;
  select * into v_city from public.sjelle_cities where id=v_route.city_id for share;
  if not found or not v_city.active or not v_city.rides_enabled then raise exception using errcode='P0001', message='CITY_UNAVAILABLE'; end if;
  insert into public.sjelle_rides(
    customer_id,city_id,vehicle_type,pickup_label,pickup_lat,pickup_lon,destination_label,destination_lat,destination_lon,
    status,pricing_kind,pricing_version,quoted_amount_cents,payment_method,sjelle_cash_status,idempotency_key
  ) values (
    p_customer_id,v_city.id,v_route.vehicle_type,v_route.origin_label,v_route.origin_lat,v_route.origin_lon,
    v_route.destination_label,v_route.destination_lat,v_route.destination_lon,'searching','fixed_route',v_route.version,
    v_route.amount_cents,'cash','due',p_idempotency_key
  ) returning * into v_ride;
  insert into public.sjelle_ride_events(ride_id,actor_id,event_type,event_data)
  values(v_ride.id,p_customer_id,'ride.requested',jsonb_build_object('route_id',v_route.id,'pricing_version',v_route.version,'quoted_amount_cents',v_route.amount_cents));
  insert into public.sjelle_audit_logs(actor_id,action,target_type,target_id,metadata)
  values(p_customer_id,'ride.created','ride',v_ride.id::text,jsonb_build_object('route_id',v_route.id,'amount_cents',v_route.amount_cents));
  v_offer := public.sjelle_offer_next_driver('ride',v_ride.id);
  return jsonb_build_object('id',v_ride.id,'status',v_ride.status,'quoted_amount_cents',v_ride.quoted_amount_cents,'currency','EUR','driver_offer_sent',coalesce((v_offer->>'offered')::boolean,false),'replayed',false);
end;
$function$


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
begin
  if p_response not in ('accept','reject') then raise exception using errcode='P0001',message='INVALID_OFFER_RESPONSE'; end if;
  select * into v_offer from public.sjelle_driver_offers where id=p_offer_id and driver_id=p_driver_id for update;
  if not found then raise exception using errcode='P0001',message='OFFER_NOT_FOUND'; end if;
  if v_offer.status<>'offered' or v_offer.expires_at<=now() then
    update public.sjelle_driver_offers set status='expired' where id=v_offer.id and status='offered';
    raise exception using errcode='P0001',message='OFFER_EXPIRED';
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
  update public.sjelle_food_orders set status='courier_assigned',updated_at=now()
    where id=v_job.order_id and status in ('accepted','preparing','ready_for_pickup');
  update public.sjelle_driver_offers set status='accepted' where id=v_offer.id;
  update public.sjelle_driver_offers set status='withdrawn' where delivery_job_id=v_job.id and id<>v_offer.id and status='offered';
  insert into public.sjelle_audit_logs(actor_id,action,target_type,target_id,metadata)
    values(p_driver_id,'delivery.offer.accepted','delivery_job',v_job.id::text,jsonb_build_object('offer_id',v_offer.id,'order_id',v_job.order_id));
  return jsonb_build_object('status','accepted','job_kind','delivery','job_id',v_job.id);
end;
$function$


CREATE OR REPLACE FUNCTION public.sjelle_driver_update_job(p_driver_id uuid, p_job_kind text, p_job_id uuid, p_next_status text, p_cash_collected boolean DEFAULT false)
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
  if not exists(select 1 from public.sjelle_driver_profiles where user_id=p_driver_id and review_status='approved') then
    raise exception using errcode='P0001',message='DRIVER_NOT_APPROVED';
  end if;
  if p_job_kind='ride' then
    select * into v_ride from public.sjelle_rides where id=p_job_id and driver_id=p_driver_id for update;
    if not found then raise exception using errcode='P0001',message='JOB_NOT_FOUND'; end if;
    if not (
      (v_ride.status='driver_assigned' and p_next_status='driver_arriving') or
      (v_ride.status='driver_arriving' and p_next_status='driver_arrived') or
      (v_ride.status='driver_arrived' and p_next_status='in_progress') or
      (v_ride.status='in_progress' and p_next_status='completed')
    ) then raise exception using errcode='P0001',message='INVALID_JOB_TRANSITION'; end if;
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
    if not found then raise exception using errcode='P0001',message='JOB_NOT_FOUND'; end if;
    select * into v_order from public.sjelle_food_orders where id=v_job.order_id for update;
    if p_next_status='arriving' and v_job.status='assigned' then
      update public.sjelle_delivery_jobs set status='arriving' where id=v_job.id;
    elsif p_next_status='arrived' and v_job.status='arriving' then
      update public.sjelle_delivery_jobs set status='arrived' where id=v_job.id;
    elsif p_next_status='picked_up' and v_job.status in ('assigned','arriving','arrived') then
      if v_order.ready_at is null or v_order.status not in ('ready_for_pickup','courier_assigned') then
        raise exception using errcode='P0001',message='ORDER_NOT_READY_FOR_PICKUP';
      end if;
      update public.sjelle_delivery_jobs set status='in_progress',picked_up_at=now() where id=v_job.id;
      update public.sjelle_food_orders set status='picked_up',picked_up_at=now(),updated_at=now() where id=v_order.id;
    elsif p_next_status='delivered' and v_job.status='in_progress' then
      update public.sjelle_delivery_jobs set status='completed',delivered_at=now() where id=v_job.id;
      update public.sjelle_food_orders set status='delivered',delivered_at=now(),updated_at=now(),
        sjelle_cash_status=case when p_cash_collected then 'collected'::public.sjelle_cash_status else sjelle_cash_status end
        where id=v_order.id;
    else raise exception using errcode='P0001',message='INVALID_JOB_TRANSITION';
    end if;
    insert into public.sjelle_audit_logs(actor_id,action,target_type,target_id,metadata)
      values(p_driver_id,'delivery.status_changed','delivery_job',v_job.id::text,jsonb_build_object('status',p_next_status,'cash_collected',p_cash_collected));
    return jsonb_build_object('job_id',v_job.id,'status',p_next_status);
  else
    raise exception using errcode='P0001',message='INVALID_JOB_KIND';
  end if;
end;
$function$



revoke all on function public.sjelle_handle_new_user() from public, anon, authenticated;
revoke all on function public.sjelle_create_food_order(uuid,uuid,text,text,double precision,double precision,text,jsonb) from public, anon, authenticated;
grant execute on function public.sjelle_create_food_order(uuid,uuid,text,text,double precision,double precision,text,jsonb) to service_role;
revoke all on function public.sjelle_cancel_food_order(uuid,uuid) from public, anon, authenticated;
grant execute on function public.sjelle_cancel_food_order(uuid,uuid) to service_role;
revoke all on function public.sjelle_update_food_order_status(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.sjelle_update_food_order_status(uuid,uuid,text) to service_role;
revoke all on function public.sjelle_book_fixed_route_ride(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.sjelle_book_fixed_route_ride(uuid,uuid,text) to service_role;
revoke all on function public.sjelle_offer_next_driver(text,uuid) from public, anon, authenticated;
grant execute on function public.sjelle_offer_next_driver(text,uuid) to service_role;
revoke all on function public.sjelle_respond_driver_offer(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.sjelle_respond_driver_offer(uuid,uuid,text) to service_role;
revoke all on function public.sjelle_driver_update_job(uuid,text,uuid,text,boolean) from public, anon, authenticated;
grant execute on function public.sjelle_driver_update_job(uuid,text,uuid,text,boolean) to service_role;


drop trigger if exists sjelle_auth_user_created on auth.users;
create trigger sjelle_auth_user_created after insert on auth.users for each row execute function public.sjelle_handle_new_user();