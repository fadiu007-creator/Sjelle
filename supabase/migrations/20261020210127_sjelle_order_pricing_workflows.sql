-- Sjelle additive order/pricing workflows, applied to shared Supabase project zikos.
-- Namespaced objects only. Never modify unrelated applications through this migration.

create table if not exists public.sjelle_city_pricing (
  city_id uuid primary key references public.sjelle_cities(id) on delete cascade,
  version text not null,
  food_delivery_fee_cents integer not null check (food_delivery_fee_cents >= 0),
  food_service_fee_cents integer not null default 0 check (food_service_fee_cents >= 0),
  food_minimum_subtotal_cents integer not null default 0 check (food_minimum_subtotal_cents >= 0),
  ride_base_fare_cents integer,
  ride_minimum_fare_cents integer,
  ride_per_km_cents integer,
  ride_per_minute_cents integer,
  active boolean not null default false,
  updated_at timestamptz not null default now(),
  check (ride_base_fare_cents is null or ride_base_fare_cents >= 0),
  check (ride_minimum_fare_cents is null or ride_minimum_fare_cents >= 0),
  check (ride_per_km_cents is null or ride_per_km_cents >= 0),
  check (ride_per_minute_cents is null or ride_per_minute_cents >= 0)
);

alter table public.sjelle_fixed_route_prices
  add column if not exists origin_lat double precision,
  add column if not exists origin_lon double precision,
  add column if not exists destination_lat double precision,
  add column if not exists destination_lon double precision;
alter table public.sjelle_fixed_route_prices
  add constraint sjelle_fixed_route_origin_lat_check check (origin_lat is null or origin_lat between -90 and 90),
  add constraint sjelle_fixed_route_origin_lon_check check (origin_lon is null or origin_lon between -180 and 180),
  add constraint sjelle_fixed_route_destination_lat_check check (destination_lat is null or destination_lat between -90 and 90),
  add constraint sjelle_fixed_route_destination_lon_check check (destination_lon is null or destination_lon between -180 and 180);
create index if not exists sjelle_fixed_route_active_city_idx
  on public.sjelle_fixed_route_prices(city_id, active, vehicle_type, effective_from, effective_until);

alter table public.sjelle_city_pricing enable row level security;
revoke all on table public.sjelle_city_pricing from anon, authenticated;
grant all on table public.sjelle_city_pricing to service_role;

create or replace function public.sjelle_handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
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
$$;
revoke all on function public.sjelle_handle_new_user() from public, anon, authenticated;
drop trigger if exists sjelle_auth_user_created on auth.users;
create trigger sjelle_auth_user_created
after insert on auth.users
for each row execute function public.sjelle_handle_new_user();

create or replace function public.sjelle_create_food_order(
  p_customer_id uuid, p_restaurant_id uuid, p_idempotency_key text,
  p_delivery_address_text text, p_delivery_lat double precision, p_delivery_lon double precision,
  p_delivery_instructions text, p_items jsonb
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
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
  if not found then raise exception using errcode='P0001', message='FOOD_PRICING_NOT_CONFIGURED'; end if;

  for v_item in select * from jsonb_to_recordset(p_items) as x(id uuid, quantity integer) loop
    select * into v_menu_item from public.sjelle_menu_items
      where id=v_item.id and restaurant_id=v_restaurant.id and available for share;
    if not found then raise exception using errcode='P0001', message='MENU_ITEM_UNAVAILABLE'; end if;
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
$$;
revoke all on function public.sjelle_create_food_order(uuid,uuid,text,text,double precision,double precision,text,jsonb) from public, anon, authenticated;
grant execute on function public.sjelle_create_food_order(uuid,uuid,text,text,double precision,double precision,text,jsonb) to service_role;

create or replace function public.sjelle_cancel_food_order(p_customer_id uuid, p_order_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_order public.sjelle_food_orders%rowtype;
begin
  update public.sjelle_food_orders set status='cancelled', cancelled_at=now(),
    cancellation_reason='customer_cancelled', updated_at=now()
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
$$;
revoke all on function public.sjelle_cancel_food_order(uuid,uuid) from public, anon, authenticated;
grant execute on function public.sjelle_cancel_food_order(uuid,uuid) to service_role;

create or replace function public.sjelle_update_food_order_status(p_actor_id uuid, p_order_id uuid, p_next_status text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_order public.sjelle_food_orders%rowtype;
  v_restaurant public.sjelle_restaurants%rowtype;
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
  if not found or not (
    v_restaurant.owner_id=p_actor_id or exists (
      select 1 from public.sjelle_restaurant_staff s
      where s.restaurant_id=v_restaurant.id and s.user_id=p_actor_id and s.can_manage_orders
    )
  ) then raise exception using errcode='P0001', message='FORBIDDEN'; end if;
  if not (
    (v_order.status='submitted' and v_next in ('accepted','rejected')) or
    (v_order.status='accepted' and v_next='preparing') or
    (v_order.status='preparing' and v_next='ready_for_pickup')
  ) then raise exception using errcode='P0001', message='INVALID_ORDER_TRANSITION'; end if;
  update public.sjelle_food_orders set status=v_next,
    accepted_at=case when v_next='accepted' then now() else accepted_at end,
    ready_at=case when v_next='ready_for_pickup' then now() else ready_at end,
    updated_at=now()
  where id=v_order.id returning * into v_order;
  if v_next='accepted' then
    insert into public.sjelle_delivery_jobs(order_id,pickup_lat,pickup_lon,delivery_lat,delivery_lon,status)
    values (v_order.id,v_restaurant.latitude,v_restaurant.longitude,v_order.delivery_lat,v_order.delivery_lon,'searching')
    on conflict (order_id) do nothing;
  end if;
  insert into public.sjelle_audit_logs(actor_id, action, target_type, target_id, metadata)
  values (p_actor_id, 'food_order.status_changed', 'food_order', v_order.id::text, jsonb_build_object('status',v_next));
  return jsonb_build_object('id',v_order.id,'status',v_order.status);
end;
$$;
revoke all on function public.sjelle_update_food_order_status(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.sjelle_update_food_order_status(uuid,uuid,text) to service_role;

create or replace function public.sjelle_book_fixed_route_ride(p_customer_id uuid, p_route_id uuid, p_idempotency_key text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_existing public.sjelle_rides%rowtype;
  v_route public.sjelle_fixed_route_prices%rowtype;
  v_city public.sjelle_cities%rowtype;
  v_ride public.sjelle_rides%rowtype;
begin
  if p_customer_id is null or p_route_id is null or p_idempotency_key is null
    or length(p_idempotency_key) < 12 or length(p_idempotency_key) > 128 then
    raise exception using errcode='P0001', message='INVALID_RIDE_REQUEST';
  end if;
  select * into v_existing from public.sjelle_rides
    where customer_id=p_customer_id and idempotency_key=p_idempotency_key;
  if found then
    return jsonb_build_object('id',v_existing.id,'status',v_existing.status,'quoted_amount_cents',v_existing.quoted_amount_cents,'currency','EUR','replayed',true);
  end if;
  select * into v_route from public.sjelle_fixed_route_prices
   where id=p_route_id and active and effective_from <= now()
     and (effective_until is null or effective_until > now())
     and origin_lat is not null and origin_lon is not null
     and destination_lat is not null and destination_lon is not null
   for share;
  if not found then raise exception using errcode='P0001', message='ROUTE_NOT_AVAILABLE'; end if;
  select * into v_city from public.sjelle_cities where id=v_route.city_id for share;
  if not found or not v_city.active or not v_city.rides_enabled then
    raise exception using errcode='P0001', message='CITY_UNAVAILABLE';
  end if;
  if not exists(select 1 from public.sjelle_city_pricing p where p.city_id=v_city.id and p.active) then
    raise exception using errcode='P0001', message='CITY_PRICING_NOT_CONFIGURED';
  end if;
  insert into public.sjelle_rides(
    customer_id,city_id,vehicle_type,pickup_label,pickup_lat,pickup_lon,destination_label,destination_lat,destination_lon,
    status,pricing_kind,pricing_version,quoted_amount_cents,payment_method,sjelle_cash_status,distance_m,duration_s,idempotency_key
  ) values (
    p_customer_id,v_city.id,v_route.vehicle_type,v_route.origin_label,v_route.origin_lat,v_route.origin_lon,
    v_route.destination_label,v_route.destination_lat,v_route.destination_lon,'searching','fixed_route',
    v_route.version,v_route.amount_cents,'cash','due',null,null,p_idempotency_key
  ) returning * into v_ride;
  insert into public.sjelle_ride_events(ride_id,actor_id,event_type,event_data)
  values(v_ride.id,p_customer_id,'ride.requested',jsonb_build_object('route_id',v_route.id,'pricing_version',v_route.version,'quoted_amount_cents',v_route.amount_cents));
  insert into public.sjelle_audit_logs(actor_id,action,target_type,target_id,metadata)
  values(p_customer_id,'ride.created','ride',v_ride.id::text,jsonb_build_object('route_id',v_route.id,'amount_cents',v_route.amount_cents));
  return jsonb_build_object('id',v_ride.id,'status',v_ride.status,'quoted_amount_cents',v_ride.quoted_amount_cents,'currency','EUR','replayed',false);
end;
$$;
revoke all on function public.sjelle_book_fixed_route_ride(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.sjelle_book_fixed_route_ride(uuid,uuid,text) to service_role;

grant all on table public.sjelle_ride_events, public.sjelle_audit_logs, public.sjelle_delivery_jobs,
  public.sjelle_food_order_items, public.sjelle_food_orders, public.sjelle_rides to service_role;
