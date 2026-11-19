create index if not exists sjelle_driver_documents_pending_queue_idx
  on public.sjelle_driver_documents (created_at asc, id asc)
  where review_status = 'pending';

create index if not exists sjelle_vehicles_pending_queue_idx
  on public.sjelle_vehicles (created_at asc, id asc)
  where review_status = 'pending';

create index if not exists sjelle_driver_profiles_pending_queue_idx
  on public.sjelle_driver_profiles (created_at asc, user_id asc)
  where review_status = 'pending';

create index if not exists sjelle_restaurants_pending_queue_idx
  on public.sjelle_restaurants (created_at asc, id asc)
  where approval_status = 'pending';
