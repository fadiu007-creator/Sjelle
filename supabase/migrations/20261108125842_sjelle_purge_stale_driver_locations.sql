-- Minimize retention of precise driver GPS coordinates.
-- A single latest-location row is kept only while it is fresh; active ride tracking
-- already refuses locations older than 120 seconds.
create or replace function public.sjelle_purge_stale_driver_locations()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_deleted integer;
begin
  delete from public.sjelle_driver_locations
  where updated_at < now() - interval '15 minutes';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$function$;

revoke all on function public.sjelle_purge_stale_driver_locations() from public, anon, authenticated;
grant execute on function public.sjelle_purge_stale_driver_locations() to service_role;

create extension if not exists pg_cron;

do $$
declare
  existing_job_id bigint;
begin
  select jobid into existing_job_id
  from cron.job
  where jobname = 'sjelle-purge-stale-driver-locations';

  if existing_job_id is not null then
    perform cron.unschedule(existing_job_id);
  end if;

  perform cron.schedule(
    'sjelle-purge-stale-driver-locations',
    '*/5 * * * *',
    'select public.sjelle_purge_stale_driver_locations();'
  );
end
$$;
