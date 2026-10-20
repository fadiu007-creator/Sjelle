-- Public restaurant discovery needs a narrow column allowlist.
-- Owner identity, private phone and commission settings are not public fields.
revoke select on table public.sjelle_restaurants from anon, authenticated;
grant select (
  id, city_id, name, slug, description, address_text,
  latitude, longitude, image_path, approval_status, is_open,
  delivery_enabled, prep_time_minutes, created_at, updated_at
) on table public.sjelle_restaurants to anon, authenticated;

-- Keep sensitive accounting and audit data server-only even if broad grants are
-- introduced later. RLS remains enabled on these tables as defense in depth.
revoke all on table public.sjelle_ledger_entries from anon, authenticated;
revoke all on table public.sjelle_audit_logs from anon, authenticated;
revoke all on table public.sjelle_driver_locations from anon, authenticated;
