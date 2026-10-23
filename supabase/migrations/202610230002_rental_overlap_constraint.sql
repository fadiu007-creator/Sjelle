-- Enforce rental date conflicts at the database level to prevent concurrent double-booking.
create extension if not exists btree_gist;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'rental_bookings_no_active_overlap'
      and conrelid = 'public.rental_bookings'::regclass
  ) then
    alter table public.rental_bookings
      add constraint rental_bookings_no_active_overlap
      exclude using gist (
        vehicle_id with =,
        tstzrange(pickup_at, return_at, '[)') with &&
      )
      where (status in ('requested','confirmed','picked_up'));
  end if;
end $$;

comment on constraint rental_bookings_no_active_overlap on public.rental_bookings
  is 'Prevents overlapping active rental periods for the same vehicle, including concurrent booking requests.';
