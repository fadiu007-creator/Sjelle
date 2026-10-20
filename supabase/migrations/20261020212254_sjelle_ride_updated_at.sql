-- Add update timestamp required by cancellation and operational status changes.
alter table public.sjelle_rides add column if not exists updated_at timestamptz not null default now();
