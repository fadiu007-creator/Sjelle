create extension if not exists pg_cron;

do $$
declare
  existing_job_id bigint;
begin
  select jobid into existing_job_id
  from cron.job
  where jobname = 'sjelle-dispatch-recovery';

  if existing_job_id is not null then
    perform cron.unschedule(existing_job_id);
  end if;

  perform cron.schedule(
    'sjelle-dispatch-recovery',
    '* * * * *',
    'select public.sjelle_dispatch_waiting_jobs();'
  );
end
$$;
