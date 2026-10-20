-- Persisted server-calculated quotes; the browser never supplies a fare.
create table if not exists public.sjelle_ride_quotes (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references auth.users(id) on delete cascade,
  city_id uuid not null references public.sjelle_cities(id),
  vehicle_type text not null default 'standard' check (vehicle_type in ('standard','comfort','van')),
  pickup_label text not null,
  pickup_lat double precision not null check (pickup_lat between -90 and 90),
  pickup_lon double precision not null check (pickup_lon between -180 and 180),
  destination_label text not null,
  destination_lat double precision not null check (destination_lat between -90 and 90),
  destination_lon double precision not null check (destination_lon between -180 and 180),
  pricing_kind text not null check (pricing_kind in ('fixed_route','estimated')),
  pricing_version text not null,
  quoted_amount_cents integer not null check (quoted_amount_cents > 0),
  distance_m integer not null check (distance_m > 0),
  duration_s integer not null check (duration_s > 0),
  fixed_route_price_id uuid references public.sjelle_fixed_route_prices(id),
  expires_at timestamptz not null default (now()+interval '5 minutes'),
  consumed_ride_id uuid references public.sjelle_rides(id),
  created_at timestamptz not null default now()
);
create index if not exists sjelle_ride_quotes_customer_expiry_idx on public.sjelle_ride_quotes(customer_id,expires_at desc);
alter table public.sjelle_ride_quotes enable row level security;
revoke all on table public.sjelle_ride_quotes from anon,authenticated;
grant all on table public.sjelle_ride_quotes to service_role;

CREATE OR REPLACE FUNCTION public.sjelle_book_ride_quote(p_customer_id uuid, p_quote_id uuid, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_quote public.sjelle_ride_quotes%rowtype;
  v_ride public.sjelle_rides%rowtype;
  v_city public.sjelle_cities%rowtype;
  v_offer jsonb;
begin
  if p_customer_id is null or p_quote_id is null or p_idempotency_key is null
    or length(p_idempotency_key)<12 or length(p_idempotency_key)>128 then
    raise exception using errcode='P0001',message='INVALID_RIDE_REQUEST';
  end if;
  select * into v_ride from public.sjelle_rides where customer_id=p_customer_id and idempotency_key=p_idempotency_key;
  if found then return jsonb_build_object('id',v_ride.id,'status',v_ride.status,'quoted_amount_cents',v_ride.quoted_amount_cents,'currency','EUR','replayed',true); end if;
  select * into v_quote from public.sjelle_ride_quotes where id=p_quote_id and customer_id=p_customer_id for update;
  if not found then raise exception using errcode='P0001',message='RIDE_QUOTE_NOT_FOUND'; end if;
  if v_quote.consumed_ride_id is not null then raise exception using errcode='P0001',message='RIDE_QUOTE_ALREADY_USED'; end if;
  if v_quote.expires_at<=now() then raise exception using errcode='P0001',message='RIDE_QUOTE_EXPIRED'; end if;
  select * into v_city from public.sjelle_cities where id=v_quote.city_id for share;
  if not found or not v_city.active or not v_city.rides_enabled then raise exception using errcode='P0001',message='CITY_UNAVAILABLE'; end if;
  insert into public.sjelle_rides(
    customer_id,city_id,vehicle_type,pickup_label,pickup_lat,pickup_lon,destination_label,destination_lat,destination_lon,
    status,pricing_kind,pricing_version,quoted_amount_cents,payment_method,sjelle_cash_status,distance_m,duration_s,idempotency_key
  ) values (
    p_customer_id,v_quote.city_id,v_quote.vehicle_type,v_quote.pickup_label,v_quote.pickup_lat,v_quote.pickup_lon,
    v_quote.destination_label,v_quote.destination_lat,v_quote.destination_lon,'searching',v_quote.pricing_kind,v_quote.pricing_version,
    v_quote.quoted_amount_cents,'cash','due',v_quote.distance_m,v_quote.duration_s,p_idempotency_key
  ) returning * into v_ride;
  update public.sjelle_ride_quotes set consumed_ride_id=v_ride.id where id=v_quote.id;
  insert into public.sjelle_ride_events(ride_id,actor_id,event_type,event_data)
    values(v_ride.id,p_customer_id,'ride.requested',jsonb_build_object('quote_id',v_quote.id,'pricing_version',v_quote.pricing_version,'quoted_amount_cents',v_quote.quoted_amount_cents,'distance_m',v_quote.distance_m,'duration_s',v_quote.duration_s));
  insert into public.sjelle_audit_logs(actor_id,action,target_type,target_id,metadata)
    values(p_customer_id,'ride.created','ride',v_ride.id::text,jsonb_build_object('quote_id',v_quote.id,'amount_cents',v_quote.quoted_amount_cents));
  v_offer := public.sjelle_offer_next_driver('ride',v_ride.id);
  return jsonb_build_object('id',v_ride.id,'status',v_ride.status,'quoted_amount_cents',v_ride.quoted_amount_cents,'currency','EUR','driver_offer_sent',coalesce((v_offer->>'offered')::boolean,false),'replayed',false);
end;
$function$
;

revoke all on function public.sjelle_book_ride_quote(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.sjelle_book_ride_quote(uuid,uuid,text) to service_role;
