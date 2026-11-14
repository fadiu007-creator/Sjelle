-- Keep driver profile creation and role assignment in one PostgreSQL transaction.
-- Called only by the Sjelle API using its server-side service-role credential.
create or replace function public.sjelle_apply_for_driver(
  p_user_id uuid,
  p_city_id uuid,
  p_selected_mode text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user_id is null or p_city_id is null or p_selected_mode not in ('ride', 'delivery') then
    raise exception using errcode = '22023', message = 'INVALID_DRIVER_APPLICATION';
  end if;

  insert into public.sjelle_driver_profiles (
    user_id, city_id, selected_mode, online
  ) values (
    p_user_id, p_city_id, p_selected_mode, false
  );

  insert into public.sjelle_user_roles (user_id, role)
  values (p_user_id, 'driver')
  on conflict (user_id, role) do nothing;

  return jsonb_build_object(
    'application_status', 'pending',
    'city_id', p_city_id,
    'mode', p_selected_mode,
    'online', false
  );
end;
$$;

revoke all on function public.sjelle_apply_for_driver(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.sjelle_apply_for_driver(uuid, uuid, text) to service_role;
