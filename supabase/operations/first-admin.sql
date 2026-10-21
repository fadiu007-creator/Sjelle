-- Sjelle first-admin bootstrap for the existing shared Supabase project.
-- Run manually in Supabase SQL Editor ONLY after replacing the email below with the
-- exact email of the account you control. Never run with the placeholder unchanged.
-- This touches only public.sjelle_user_roles and reads auth.users; it does not alter
-- any other app's roles or tables.

do $$
declare
  admin_email text := lower(trim('REPLACE_WITH_YOUR_CONFIRMED_ACCOUNT_EMAIL'));
  admin_user_id uuid;
begin
  if admin_email = '' or admin_email = 'replace_with_your_confirmed_account_email' then
    raise exception 'Replace the email placeholder with the exact confirmed Sjelle administrator account email.';
  end if;

  select id
    into admin_user_id
    from auth.users
   where lower(email) = admin_email
     and email_confirmed_at is not null
   limit 1;

  if admin_user_id is null then
    raise exception 'No confirmed Supabase Auth user found for %. Sign up and confirm this account first, then rerun.', admin_email;
  end if;

  insert into public.sjelle_user_roles (user_id, role)
  values (admin_user_id, 'admin'::public.sjelle_app_role)
  on conflict do nothing;

  raise notice 'Sjelle admin role ensured for confirmed user % (id %).', admin_email, admin_user_id;
end
$$;

-- Verify the intended account only:
-- select u.email, r.role, r.granted_at
-- from auth.users u
-- join public.sjelle_user_roles r on r.user_id = u.id
-- where lower(u.email) = lower('YOUR_CONFIRMED_ACCOUNT_EMAIL');
