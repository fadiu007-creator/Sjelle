-- Sjelle car rentals: initial schema.
-- Apply to the existing Sjelle Supabase project; this migration does not create a project.

create extension if not exists pgcrypto;

create table if not exists public.rental_companies (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 2 and 120),
  phone text not null check (char_length(trim(phone)) between 5 and 32),
  city_slug text not null check (city_slug in ('prishtina','ferizaj','prizren','gjilan','mitrovica','peja')),
  address text,
  description text,
  verification_status text not null default 'pending'
    check (verification_status in ('pending','approved','rejected','suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.rental_vehicles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.rental_companies(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  make text not null check (char_length(trim(make)) between 1 and 60),
  model text not null check (char_length(trim(model)) between 1 and 80),
  model_year integer not null check (model_year between 1980 and extract(year from now())::integer + 2),
  category text not null default 'economy'
    check (category in ('mini','economy','compact','sedan','suv','van','luxury')),
  transmission text not null check (transmission in ('manual','automatic')),
  fuel_type text not null check (fuel_type in ('petrol','diesel','hybrid','electric','lpg')),
  seats integer not null default 5 check (seats between 2 and 9),
  daily_price_cents integer not null check (daily_price_cents between 100 and 2000000),
  deposit_cents integer not null default 0 check (deposit_cents between 0 and 10000000),
  mileage_limit_km integer check (mileage_limit_km is null or mileage_limit_km >= 0),
  description text,
  photo_urls text[] not null default '{}',
  city_slug text not null check (city_slug in ('prishtina','ferizaj','prizren','gjilan','mitrovica','peja')),
  pickup_address text,
  status text not null default 'pending'
    check (status in ('pending','approved','rejected','paused','unavailable')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.rental_bookings (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references public.rental_vehicles(id) on delete restrict,
  company_id uuid not null references public.rental_companies(id) on delete restrict,
  customer_user_id uuid not null references auth.users(id) on delete cascade,
  pickup_at timestamptz not null,
  return_at timestamptz not null,
  pickup_location text,
  return_location text,
  rental_days integer not null check (rental_days between 1 and 366),
  daily_price_cents integer not null check (daily_price_cents > 0),
  deposit_cents integer not null default 0 check (deposit_cents >= 0),
  total_price_cents integer not null check (total_price_cents > 0),
  status text not null default 'requested'
    check (status in ('requested','confirmed','declined','cancelled','picked_up','returned','no_show')),
  customer_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (return_at > pickup_at),
  check (total_price_cents >= daily_price_cents * rental_days)
);

create index if not exists rental_companies_owner_idx on public.rental_companies(owner_user_id);
create index if not exists rental_vehicles_company_idx on public.rental_vehicles(company_id);
create index if not exists rental_vehicles_search_idx on public.rental_vehicles(city_slug, status, daily_price_cents);
create index if not exists rental_bookings_vehicle_dates_idx on public.rental_bookings(vehicle_id, pickup_at, return_at);
create index if not exists rental_bookings_customer_idx on public.rental_bookings(customer_user_id, created_at desc);
create index if not exists rental_bookings_company_idx on public.rental_bookings(company_id, created_at desc);

alter table public.rental_companies enable row level security;
alter table public.rental_vehicles enable row level security;
alter table public.rental_bookings enable row level security;

-- Public customers can discover approved providers and listed vehicles only.
drop policy if exists rental_companies_public_approved on public.rental_companies;
create policy rental_companies_public_approved on public.rental_companies
  for select to anon, authenticated using (verification_status = 'approved' or owner_user_id = auth.uid());

drop policy if exists rental_companies_owner_manage on public.rental_companies;
create policy rental_companies_owner_manage on public.rental_companies
  for all to authenticated using (owner_user_id = auth.uid())
  with check (owner_user_id = auth.uid());

drop policy if exists rental_vehicles_public_approved on public.rental_vehicles;
create policy rental_vehicles_public_approved on public.rental_vehicles
  for select to anon, authenticated using (
    status = 'approved' and exists (
      select 1 from public.rental_companies c
      where c.id = company_id and c.verification_status = 'approved'
    )
    or owner_user_id = auth.uid()
  );

drop policy if exists rental_vehicles_owner_manage on public.rental_vehicles;
create policy rental_vehicles_owner_manage on public.rental_vehicles
  for all to authenticated using (owner_user_id = auth.uid())
  with check (owner_user_id = auth.uid());

-- A customer sees their bookings; provider owners can see bookings for their fleet.
drop policy if exists rental_bookings_participant_read on public.rental_bookings;
create policy rental_bookings_participant_read on public.rental_bookings
  for select to authenticated using (
    customer_user_id = auth.uid()
    or exists (select 1 from public.rental_companies c
      where c.id = company_id and c.owner_user_id = auth.uid())
  );

-- Booking creation is customer-owned. State transitions and overlap checks should
-- be enforced in the authenticated Sjelle API, not by trusting client-supplied fields.
drop policy if exists rental_bookings_customer_create on public.rental_bookings;
create policy rental_bookings_customer_create on public.rental_bookings
  for insert to authenticated with check (customer_user_id = auth.uid());

drop policy if exists rental_bookings_provider_update on public.rental_bookings;
create policy rental_bookings_provider_update on public.rental_bookings
  for update to authenticated using (
    exists (select 1 from public.rental_companies c
      where c.id = company_id and c.owner_user_id = auth.uid())
  ) with check (
    exists (select 1 from public.rental_companies c
      where c.id = company_id and c.owner_user_id = auth.uid())
  );

comment on table public.rental_companies is 'Sjelle car-rental providers; approval is required before public discovery.';
comment on table public.rental_vehicles is 'Rental fleet listings with euro-cent pricing and owner-scoped management.';
comment on table public.rental_bookings is 'Date-bounded car-rental requests; availability overlap and status transitions must be validated server-side.';
