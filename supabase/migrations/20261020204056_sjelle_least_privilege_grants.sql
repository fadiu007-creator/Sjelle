-- Explicit least-privilege grants for Sjelle's namespaced tables in shared project zikos.
-- Never alter grants or policies on unrelated applications.
revoke all on table
  public.sjelle_profiles, public.sjelle_user_roles, public.sjelle_cities,
  public.sjelle_service_areas, public.sjelle_driver_profiles, public.sjelle_vehicles,
  public.sjelle_driver_documents, public.sjelle_driver_locations, public.sjelle_saved_addresses,
  public.sjelle_rides, public.sjelle_ride_events, public.sjelle_fixed_route_prices,
  public.sjelle_restaurants, public.sjelle_restaurant_staff, public.sjelle_menu_categories,
  public.sjelle_menu_items, public.sjelle_menu_item_options, public.sjelle_food_orders,
  public.sjelle_food_order_items, public.sjelle_delivery_jobs, public.sjelle_driver_offers,
  public.sjelle_ledger_entries, public.sjelle_ratings, public.sjelle_support_tickets,
  public.sjelle_audit_logs
from anon, authenticated;

-- Public discovery surfaces; row policies still filter inactive/unapproved data.
grant select on table public.sjelle_cities, public.sjelle_service_areas,
  public.sjelle_menu_categories, public.sjelle_menu_items, public.sjelle_menu_item_options
to anon, authenticated;
grant select (
  id, city_id, name, slug, description, address_text,
  latitude, longitude, image_path, approval_status, is_open,
  delivery_enabled, prep_time_minutes, created_at, updated_at
) on table public.sjelle_restaurants to anon, authenticated;

-- Authenticated users can read their own account data and their own platform activity.
grant select, update on table public.sjelle_profiles to authenticated;
grant select on table public.sjelle_user_roles, public.sjelle_driver_profiles,
  public.sjelle_vehicles, public.sjelle_driver_documents, public.sjelle_rides,
  public.sjelle_ride_events, public.sjelle_fixed_route_prices,
  public.sjelle_restaurant_staff, public.sjelle_food_orders,
  public.sjelle_food_order_items, public.sjelle_delivery_jobs,
  public.sjelle_driver_offers, public.sjelle_ratings, public.sjelle_support_tickets
to authenticated;
grant select, insert, update, delete on table public.sjelle_saved_addresses to authenticated;

-- No direct client grants for live driver coordinates, ledger, or audit data.
