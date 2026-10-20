-- Sjelle initial domain schema.
-- Apply only to a dedicated Sjelle development Supabase project after review.
-- All prices are EUR cents. No client-side policy may grant role/verification/assignment/payment authority.

create extension if not exists pgcrypto;

create type public.sjelle_app_role as enum ('customer','driver','merchant_staff','support','admin');
create type public.sjelle_driver_review_status as enum ('pending','approved','rejected','suspended');
create type public.sjelle_driver_mode as enum ('ride','delivery');
create type public.sjelle_ride_status as enum ('searching','driver_assigned','driver_arriving','driver_arrived','in_progress','completed','cancelled_by_customer','cancelled_by_driver','cancelled_by_platform','no_driver_found');
create type public.sjelle_restaurant_status as enum ('pending','approved','rejected','suspended');
create type public.sjelle_job_status as enum ('searching','offered','assigned','arriving','arrived','in_progress','completed','cancelled','rejected','expired','no_driver_found');
create type public.sjelle_food_order_status as enum ('submitted','accepted','preparing','ready_for_pickup','courier_assigned','picked_up','delivered','rejected','cancelled','delivery_failed');
create type public.sjelle_cash_status as enum ('not_due','due','collected','reconciled','disputed','refunded');

create table public.sjelle_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  phone text,
  preferred_language text not null default 'sq' check (preferred_language in ('sq','en','sr')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.sjelle_user_roles (
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.sjelle_app_role not null,
  granted_at timestamptz not null default now(),
  granted_by uuid references auth.users(id),
  primary key (user_id, role)
);

create table public.sjelle_cities (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  country_code char(2) not null default 'XK',
  timezone text not null default 'Europe/Belgrade',
  rides_enabled boolean not null default false,
  food_enabled boolean not null default false,
  active boolean not null default false,
  created_at timestamptz not null default now()
);

insert into public.sjelle_cities (slug, name) values
 ('prishtina','Prishtina'), ('ferizaj','Ferizaj'), ('prizren','Prizren'),
 ('gjilan','Gjilan'), ('mitrovica','Mitrovica'), ('peja','Peja')
on conflict (slug) do nothing;

create table public.sjelle_service_areas (
  id uuid primary key default gen_random_uuid(),
  city_id uuid not null references public.sjelle_cities(id) on delete cascade,
  name text not null,
  -- GeoJSON polygon/multipolygon; validate and version coverage in the API.
  boundary_geojson jsonb,
  active boolean not null default false,
  created_at timestamptz not null default now(),
  unique(city_id, name)
);

create table public.sjelle_driver_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  review_status public.sjelle_driver_review_status not null default 'pending',
  online boolean not null default false,
  selected_mode public.sjelle_driver_mode,
  city_id uuid references public.sjelle_cities(id),
  approved_at timestamptz,
  approved_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (review_status <> 'approved' or approved_at is not null)
);

create table public.sjelle_vehicles (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.sjelle_driver_profiles(user_id) on delete cascade,
  vehicle_type text not null check (vehicle_type in ('standard','comfort','van','motorcycle','bicycle')),
  make text,
  model text,
  color text,
  registration_number text not null,
  capacity smallint not null default 4 check (capacity between 1 and 20),
  review_status public.sjelle_driver_review_status not null default 'pending',
  document_expires_at date,
  verified_at timestamptz,
  verified_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create unique index sjelle_vehicles_registration_unique on public.sjelle_vehicles (upper(registration_number));

create table public.sjelle_driver_documents (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.sjelle_driver_profiles(user_id) on delete cascade,
  document_type text not null check (document_type in ('identity','driving_licence','vehicle_registration','insurance','other_required')),
  storage_path text not null unique,
  document_number_last4 text,
  expires_at date,
  review_status public.sjelle_driver_review_status not null default 'pending',
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id),
  rejection_reason text,
  created_at timestamptz not null default now()
);

create table public.sjelle_driver_locations (
  driver_id uuid primary key references public.sjelle_driver_profiles(user_id) on delete cascade,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  accuracy_m real,
  heading_degrees real,
  recorded_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create table public.sjelle_saved_addresses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null,
  address_text text not null,
  city_id uuid not null references public.sjelle_cities(id),
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  instructions text,
  created_at timestamptz not null default now()
);
create index sjelle_saved_addresses_user_idx on public.sjelle_saved_addresses(user_id);

create table public.sjelle_rides (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references auth.users(id),
  city_id uuid not null references public.sjelle_cities(id),
  vehicle_type text not null default 'standard',
  pickup_label text not null,
  pickup_lat double precision not null check (pickup_lat between -90 and 90),
  pickup_lon double precision not null check (pickup_lon between -180 and 180),
  destination_label text not null,
  destination_lat double precision not null check (destination_lat between -90 and 90),
  destination_lon double precision not null check (destination_lon between -180 and 180),
  status public.sjelle_ride_status not null default 'searching',
  pricing_kind text not null check (pricing_kind in ('fixed_route','estimated')),
  pricing_version text not null,
  quoted_amount_cents integer not null check (quoted_amount_cents >= 0),
  final_amount_cents integer check (final_amount_cents >= 0),
  distance_m integer check (distance_m >= 0),
  duration_s integer check (duration_s >= 0),
  payment_method text not null default 'cash' check (payment_method in ('cash','online')),
  sjelle_cash_status public.sjelle_cash_status not null default 'due',
  driver_id uuid references public.sjelle_driver_profiles(user_id),
  requested_at timestamptz not null default now(),
  accepted_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancellation_reason text,
  idempotency_key text not null,
  unique(customer_id, idempotency_key)
);
create index sjelle_rides_customer_created_idx on public.sjelle_rides(customer_id, requested_at desc);
create index sjelle_rides_driver_status_idx on public.sjelle_rides(driver_id, status);
create index sjelle_rides_city_status_idx on public.sjelle_rides(city_id, status, requested_at);

create table public.sjelle_ride_events (
  id bigint generated always as identity primary key,
  ride_id uuid not null references public.sjelle_rides(id) on delete cascade,
  actor_id uuid references auth.users(id),
  event_type text not null,
  event_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index sjelle_ride_events_ride_time_idx on public.sjelle_ride_events(ride_id, created_at);

create table public.sjelle_fixed_route_prices (
  id uuid primary key default gen_random_uuid(),
  city_id uuid not null references public.sjelle_cities(id),
  route_key text not null,
  origin_label text not null,
  destination_label text not null,
  vehicle_type text not null default 'standard',
  amount_cents integer not null check (amount_cents >= 0),
  currency char(3) not null default 'EUR' check (currency = 'EUR'),
  version text not null,
  active boolean not null default false,
  effective_from timestamptz not null default now(),
  effective_until timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  check (effective_until is null or effective_until > effective_from)
);
create index sjelle_fixed_route_prices_lookup_idx on public.sjelle_fixed_route_prices(city_id, route_key, vehicle_type, active);

create table public.sjelle_restaurants (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  city_id uuid not null references public.sjelle_cities(id),
  name text not null,
  slug text not null unique,
  description text,
  phone text,
  address_text text not null,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  image_path text,
  approval_status public.sjelle_restaurant_status not null default 'pending',
  is_open boolean not null default false,
  delivery_enabled boolean not null default false,
  prep_time_minutes integer not null default 20 check (prep_time_minutes between 0 and 240),
  commission_bps integer not null default 0 check (commission_bps between 0 and 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index sjelle_restaurants_city_status_idx on public.sjelle_restaurants(city_id, approval_status, is_open);

create table public.sjelle_restaurant_staff (
  restaurant_id uuid not null references public.sjelle_restaurants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  can_manage_menu boolean not null default false,
  can_manage_orders boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (restaurant_id, user_id)
);

create table public.sjelle_menu_categories (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.sjelle_restaurants(id) on delete cascade,
  name text not null,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.sjelle_menu_items (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.sjelle_restaurants(id) on delete cascade,
  category_id uuid references public.sjelle_menu_categories(id) on delete set null,
  name text not null,
  description text,
  image_path text,
  price_cents integer not null check (price_cents >= 0),
  available boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index sjelle_menu_items_restaurant_idx on public.sjelle_menu_items(restaurant_id, available);

create table public.sjelle_menu_item_options (
  id uuid primary key default gen_random_uuid(),
  menu_item_id uuid not null references public.sjelle_menu_items(id) on delete cascade,
  name text not null,
  extra_price_cents integer not null default 0 check (extra_price_cents >= 0),
  active boolean not null default true
);

create table public.sjelle_food_orders (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references auth.users(id),
  restaurant_id uuid not null references public.sjelle_restaurants(id),
  city_id uuid not null references public.sjelle_cities(id),
  delivery_address_text text not null,
  delivery_lat double precision not null check (delivery_lat between -90 and 90),
  delivery_lon double precision not null check (delivery_lon between -180 and 180),
  delivery_instructions text,
  status public.sjelle_food_order_status not null default 'submitted',
  payment_method text not null default 'cash' check (payment_method in ('cash','online')),
  sjelle_cash_status public.sjelle_cash_status not null default 'due',
  item_subtotal_cents integer not null check (item_subtotal_cents >= 0),
  delivery_fee_cents integer not null default 0 check (delivery_fee_cents >= 0),
  service_fee_cents integer not null default 0 check (service_fee_cents >= 0),
  discount_cents integer not null default 0 check (discount_cents >= 0),
  total_cents integer not null check (total_cents >= 0),
  currency char(3) not null default 'EUR' check (currency = 'EUR'),
  restaurant_commission_bps integer not null default 0 check (restaurant_commission_bps between 0 and 10000),
  prep_time_minutes integer,
  accepted_at timestamptz,
  ready_at timestamptz,
  picked_up_at timestamptz,
  delivered_at timestamptz,
  cancelled_at timestamptz,
  cancellation_reason text,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(customer_id, idempotency_key)
);
create index sjelle_food_orders_customer_idx on public.sjelle_food_orders(customer_id, created_at desc);
create index sjelle_food_orders_restaurant_idx on public.sjelle_food_orders(restaurant_id, status, created_at);
create index sjelle_food_orders_city_idx on public.sjelle_food_orders(city_id, status, created_at);

create table public.sjelle_food_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.sjelle_food_orders(id) on delete cascade,
  menu_item_id uuid references public.sjelle_menu_items(id) on delete set null,
  item_name_snapshot text not null,
  options_snapshot jsonb not null default '[]'::jsonb,
  unit_price_cents integer not null check (unit_price_cents >= 0),
  quantity integer not null check (quantity between 1 and 100),
  line_total_cents integer not null check (line_total_cents >= 0)
);

create table public.sjelle_delivery_jobs (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.sjelle_food_orders(id),
  driver_id uuid references public.sjelle_driver_profiles(user_id),
  status public.sjelle_job_status not null default 'searching',
  pickup_lat double precision not null check (pickup_lat between -90 and 90),
  pickup_lon double precision not null check (pickup_lon between -180 and 180),
  delivery_lat double precision not null check (delivery_lat between -90 and 90),
  delivery_lon double precision not null check (delivery_lon between -180 and 180),
  assigned_at timestamptz,
  picked_up_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);
create index sjelle_delivery_jobs_driver_status_idx on public.sjelle_delivery_jobs(driver_id, status);

create table public.sjelle_driver_offers (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.sjelle_driver_profiles(user_id),
  job_kind text not null check (job_kind in ('ride','delivery')),
  ride_id uuid references public.sjelle_rides(id) on delete cascade,
  delivery_job_id uuid references public.sjelle_delivery_jobs(id) on delete cascade,
  status text not null default 'offered' check (status in ('offered','accepted','rejected','expired','withdrawn')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  check ((job_kind = 'ride' and ride_id is not null and delivery_job_id is null) or
         (job_kind = 'delivery' and delivery_job_id is not null and ride_id is null))
);
create index sjelle_driver_offers_driver_status_idx on public.sjelle_driver_offers(driver_id, status, expires_at);
create unique index sjelle_driver_offer_ride_unique on public.sjelle_driver_offers(driver_id, ride_id) where ride_id is not null;
create unique index sjelle_driver_offer_delivery_unique on public.sjelle_driver_offers(driver_id, delivery_job_id) where delivery_job_id is not null;

create table public.sjelle_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  related_ride_id uuid references public.sjelle_rides(id),
  related_order_id uuid references public.sjelle_food_orders(id),
  account_type text not null check (account_type in ('customer_cash_due','driver_cash_collected','driver_payable','platform_revenue','merchant_payable','refund_due','adjustment')),
  account_user_id uuid references auth.users(id),
  amount_cents bigint not null check (amount_cents <> 0),
  currency char(3) not null default 'EUR' check (currency = 'EUR'),
  entry_type text not null,
  idempotency_key text not null unique,
  reversal_of uuid references public.sjelle_ledger_entries(id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (related_ride_id is not null or related_order_id is not null)
);
create index sjelle_ledger_ride_idx on public.sjelle_ledger_entries(related_ride_id);
create index sjelle_ledger_order_idx on public.sjelle_ledger_entries(related_order_id);
create index sjelle_ledger_account_idx on public.sjelle_ledger_entries(account_user_id, created_at desc);

create table public.sjelle_ratings (
  id uuid primary key default gen_random_uuid(),
  ride_id uuid references public.sjelle_rides(id),
  order_id uuid references public.sjelle_food_orders(id),
  reviewer_id uuid not null references auth.users(id),
  reviewee_id uuid references auth.users(id),
  restaurant_id uuid references public.sjelle_restaurants(id),
  score smallint not null check (score between 1 and 5),
  comment text,
  created_at timestamptz not null default now(),
  check ((ride_id is not null)::int + (order_id is not null)::int = 1),
  unique(ride_id, reviewer_id),
  unique(order_id, reviewer_id)
);

create table public.sjelle_support_tickets (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references auth.users(id),
  ride_id uuid references public.sjelle_rides(id),
  order_id uuid references public.sjelle_food_orders(id),
  category text not null,
  description text not null,
  status text not null default 'open' check (status in ('open','in_progress','resolved','closed')),
  assigned_to uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ride_id is not null or order_id is not null or length(description) > 0)
);

create table public.sjelle_audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id),
  action text not null,
  target_type text not null,
  target_id text not null,
  reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index sjelle_audit_logs_target_idx on public.sjelle_audit_logs(target_type, target_id, created_at desc);

-- RLS enabled on every public table. Writes are intentionally server-only until
-- transactional API/RPC functions and narrowly scoped write policies are reviewed.
do $$
declare t text;
begin
  foreach t in array array[
    'sjelle_profiles','sjelle_user_roles','sjelle_cities','sjelle_service_areas','sjelle_driver_profiles','sjelle_vehicles',
    'sjelle_driver_documents','sjelle_driver_locations','sjelle_saved_addresses','sjelle_rides','sjelle_ride_events',
    'sjelle_fixed_route_prices','sjelle_restaurants','sjelle_restaurant_staff','sjelle_menu_categories','sjelle_menu_items',
    'sjelle_menu_item_options','sjelle_food_orders','sjelle_food_order_items','sjelle_delivery_jobs','sjelle_driver_offers',
    'sjelle_ledger_entries','sjelle_ratings','sjelle_support_tickets','sjelle_audit_logs'
  ] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

create policy "sjelle_profiles_select_own" on public.sjelle_profiles for select to authenticated using (id = (select auth.uid()));
create policy "sjelle_profiles_update_own" on public.sjelle_profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy "sjelle_user_roles_select_own" on public.sjelle_user_roles for select to authenticated using (user_id = (select auth.uid()));

create policy "sjelle_cities_select_active" on public.sjelle_cities for select to anon, authenticated using (active = true);
create policy "sjelle_service_areas_select_active" on public.sjelle_service_areas for select to anon, authenticated using (
  active = true and exists (select 1 from public.sjelle_cities c where c.id = city_id and c.active = true)
);
create policy "sjelle_saved_addresses_select_own" on public.sjelle_saved_addresses for select to authenticated using (user_id = (select auth.uid()));
create policy "sjelle_saved_addresses_insert_own" on public.sjelle_saved_addresses for insert to authenticated with check (user_id = (select auth.uid()));
create policy "sjelle_saved_addresses_update_own" on public.sjelle_saved_addresses for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "sjelle_saved_addresses_delete_own" on public.sjelle_saved_addresses for delete to authenticated using (user_id = (select auth.uid()));

create policy "sjelle_driver_profile_select_self" on public.sjelle_driver_profiles for select to authenticated using (user_id = (select auth.uid()));
create policy "sjelle_vehicles_select_owner" on public.sjelle_vehicles for select to authenticated using (driver_id = (select auth.uid()));
create policy "sjelle_driver_documents_select_owner" on public.sjelle_driver_documents for select to authenticated using (driver_id = (select auth.uid()));
create policy "sjelle_driver_locations_select_self" on public.sjelle_driver_locations for select to authenticated using (driver_id = (select auth.uid()));

create policy "sjelle_rides_select_customer_or_assigned_driver" on public.sjelle_rides for select to authenticated using (
  customer_id = (select auth.uid()) or driver_id = (select auth.uid())
);
create policy "sjelle_ride_events_select_participant" on public.sjelle_ride_events for select to authenticated using (
  exists (select 1 from public.sjelle_rides r where r.id = ride_id and (r.customer_id = (select auth.uid()) or r.driver_id = (select auth.uid())))
);

create policy "sjelle_fixed_route_prices_select_active" on public.sjelle_fixed_route_prices for select to authenticated using (
  active = true and effective_from <= now() and (effective_until is null or effective_until > now())
);
create policy "sjelle_restaurants_select_approved" on public.sjelle_restaurants for select to anon, authenticated using (
  approval_status = 'approved' and exists (select 1 from public.sjelle_cities c where c.id = city_id and c.active = true and c.food_enabled = true)
);
create policy "sjelle_restaurant_staff_select_self" on public.sjelle_restaurant_staff for select to authenticated using (user_id = (select auth.uid()));
create policy "sjelle_menu_categories_select_public" on public.sjelle_menu_categories for select to anon, authenticated using (
  active = true and exists (select 1 from public.sjelle_restaurants r where r.id = restaurant_id and r.approval_status = 'approved' and r.is_open = true)
);
create policy "sjelle_menu_items_select_available" on public.sjelle_menu_items for select to anon, authenticated using (
  available = true and exists (select 1 from public.sjelle_restaurants r where r.id = restaurant_id and r.approval_status = 'approved' and r.is_open = true)
);
create policy "sjelle_menu_item_options_select_active" on public.sjelle_menu_item_options for select to anon, authenticated using (
  active = true and exists (select 1 from public.sjelle_menu_items mi join public.sjelle_restaurants r on r.id = mi.restaurant_id where mi.id = menu_item_id and mi.available = true and r.approval_status = 'approved' and r.is_open = true)
);

create policy "sjelle_food_orders_select_participant" on public.sjelle_food_orders for select to authenticated using (
  customer_id = (select auth.uid())
  or exists (select 1 from public.sjelle_restaurant_staff rs where rs.restaurant_id = restaurant_id and rs.user_id = (select auth.uid()))
  or exists (select 1 from public.sjelle_delivery_jobs dj where dj.order_id = id and dj.driver_id = (select auth.uid()))
);
create policy "sjelle_food_order_items_select_participant" on public.sjelle_food_order_items for select to authenticated using (
  exists (select 1 from public.sjelle_food_orders o where o.id = order_id and (
    o.customer_id = (select auth.uid())
    or exists (select 1 from public.sjelle_restaurant_staff rs where rs.restaurant_id = o.restaurant_id and rs.user_id = (select auth.uid()))
    or exists (select 1 from public.sjelle_delivery_jobs dj where dj.order_id = o.id and dj.driver_id = (select auth.uid()))
  ))
);
create policy "sjelle_delivery_jobs_select_assigned_driver" on public.sjelle_delivery_jobs for select to authenticated using (driver_id = (select auth.uid()));
create policy "sjelle_driver_offers_select_self" on public.sjelle_driver_offers for select to authenticated using (driver_id = (select auth.uid()));

create policy "sjelle_ratings_select_participant" on public.sjelle_ratings for select to authenticated using (
  reviewer_id = (select auth.uid()) or reviewee_id = (select auth.uid())
  or exists (select 1 from public.sjelle_rides r where r.id = ride_id and (r.customer_id = (select auth.uid()) or r.driver_id = (select auth.uid())))
  or exists (select 1 from public.sjelle_food_orders o where o.id = order_id and o.customer_id = (select auth.uid()))
);
create policy "sjelle_support_tickets_select_requester_or_assignee" on public.sjelle_support_tickets for select to authenticated using (
  requester_id = (select auth.uid()) or assigned_to = (select auth.uid())
);

-- No client policies for sjelle_audit_logs or sjelle_ledger_entries. Do not expose private driver
-- location to other users through direct table reads. Trusted API implements writes.
