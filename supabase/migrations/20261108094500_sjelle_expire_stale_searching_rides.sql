-- End stale ride searches instead of leaving customers in an endless spinner.
-- The dispatch recovery cron invokes this once per minute. Active offers are
-- never expired early; the timeout applies only after the request has waited
-- 15 minutes and has no unexpired driver offer.
CREATE OR REPLACE FUNCTION public.sjelle_expire_stale_searching_rides()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_expired_count integer := 0;
BEGIN
  WITH expired AS (
    UPDATE public.sjelle_rides AS r
       SET status = 'no_driver_found'
     WHERE r.status = 'searching'
       AND r.requested_at <= now() - interval '15 minutes'
       AND NOT EXISTS (
         SELECT 1
           FROM public.sjelle_driver_offers AS o
          WHERE o.ride_id = r.id
            AND o.status = 'offered'
            AND o.expires_at > now()
       )
     RETURNING r.id
  ), events AS (
    INSERT INTO public.sjelle_ride_events (ride_id, actor_id, event_type, event_data)
    SELECT id, NULL, 'ride.no_driver_found',
           jsonb_build_object('reason', 'dispatch_timeout', 'timeout_minutes', 15)
      FROM expired
    RETURNING ride_id
  )
  SELECT count(*)::integer INTO v_expired_count FROM events;

  RETURN v_expired_count;
END;
$function$;

REVOKE ALL ON FUNCTION public.sjelle_expire_stale_searching_rides() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sjelle_expire_stale_searching_rides() TO service_role;

-- Keep this separate from the existing dispatch job so deployments remain
-- additive and do not replace the established driver-selection algorithm.
DO $$
DECLARE
  existing_job_id bigint;
BEGIN
  SELECT jobid INTO existing_job_id
    FROM cron.job
   WHERE jobname = 'sjelle-expire-stale-rides';

  IF existing_job_id IS NOT NULL THEN
    PERFORM cron.unschedule(existing_job_id);
  END IF;

  PERFORM cron.schedule(
    'sjelle-expire-stale-rides',
    '* * * * *',
    'SELECT public.sjelle_expire_stale_searching_rides();'
  );
END
$$;
