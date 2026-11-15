-- Serialize driver document and vehicle review changes with final job assignment.
-- The assignment guard locks the driver profile before reading readiness evidence.
-- These triggers make uploads, reviews and removals acquire the same lock first.

create or replace function public.sjelle_lock_driver_readiness_profile()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_driver_id uuid;
begin
  if tg_op = 'UPDATE' and old.driver_id is distinct from new.driver_id then
    -- Lock both profiles in a stable order if ownership is ever corrected.
    for v_driver_id in
      select distinct driver_id
      from unnest(array[old.driver_id, new.driver_id]) as ids(driver_id)
      where driver_id is not null
      order by driver_id
    loop
      perform 1
      from public.sjelle_driver_profiles
      where user_id = v_driver_id
      for update;
    end loop;
  elsif tg_op = 'DELETE' then
    perform 1
    from public.sjelle_driver_profiles
    where user_id = old.driver_id
    for update;
  else
    perform 1
    from public.sjelle_driver_profiles
    where user_id = new.driver_id
    for update;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$function$;

drop trigger if exists sjelle_lock_driver_documents_profile on public.sjelle_driver_documents;
create trigger sjelle_lock_driver_documents_profile
before insert or update or delete on public.sjelle_driver_documents
for each row execute function public.sjelle_lock_driver_readiness_profile();

drop trigger if exists sjelle_lock_driver_vehicles_profile on public.sjelle_vehicles;
create trigger sjelle_lock_driver_vehicles_profile
before insert or update or delete on public.sjelle_vehicles
for each row execute function public.sjelle_lock_driver_readiness_profile();

revoke all on function public.sjelle_lock_driver_readiness_profile() from public, anon, authenticated;
grant execute on function public.sjelle_lock_driver_readiness_profile() to service_role;
