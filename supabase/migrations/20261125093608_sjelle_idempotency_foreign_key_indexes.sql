create index if not exists sjelle_offer_action_idempotency_offer_id_idx
  on public.sjelle_offer_action_idempotency (offer_id);

create index if not exists sjelle_ride_cancellation_idempotency_ride_id_idx
  on public.sjelle_ride_cancellation_idempotency (ride_id);
