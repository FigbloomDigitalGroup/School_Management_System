-- Lets a school admin replace their own crest/logo after onboarding — until
-- now only the platform onboarding wizard (running as super admin) could set
-- tenants.logo_url. Narrow function rather than a row-scoped update policy
-- for the same reason as set_school_payment_methods: a school admin must not
-- get a general "update my own tenant row" door onto plan/status/seats.
create or replace function set_school_logo(p_logo_url text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if my_role() <> 'school_admin' then
    raise exception 'only a school admin can set this school''s logo';
  end if;

  update tenants set logo_url = nullif(trim(p_logo_url), '') where id = my_tenant();
end;
$$;

revoke all on function set_school_logo(text) from public;
grant execute on function set_school_logo(text) to authenticated;
