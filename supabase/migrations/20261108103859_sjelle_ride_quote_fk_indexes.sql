-- Cover the foreign-key lookups on ride quotes to avoid scans during joins/deletes.
CREATE INDEX IF NOT EXISTS sjelle_ride_quotes_city_id_idx
  ON public.sjelle_ride_quotes (city_id);

CREATE INDEX IF NOT EXISTS sjelle_ride_quotes_consumed_ride_id_idx
  ON public.sjelle_ride_quotes (consumed_ride_id);

CREATE INDEX IF NOT EXISTS sjelle_ride_quotes_fixed_route_price_id_idx
  ON public.sjelle_ride_quotes (fixed_route_price_id);
