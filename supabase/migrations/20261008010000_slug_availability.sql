-- Web-address forms check availability while the address is typed, and offer
-- free alternatives when it's taken. The people filling them in mostly can't
-- read the tables: an org_admin has no SELECT on tenants (FIG-332), and the
-- sign-up page is anonymous. So these answer only "which of these addresses
-- are taken" -- no ids, names or anything else -- and addresses are public in
-- every school's URL anyway.

create or replace function tenant_slugs_taken(p_slugs text[]) returns setof text
language sql stable security definer set search_path = public as $$
  select t.slug from tenants t
   where t.slug = any (select lower(trim(s)) from unnest(p_slugs) s)
$$;

create or replace function organization_slugs_taken(p_slugs text[]) returns setof text
language sql stable security definer set search_path = public as $$
  select o.slug from organizations o
   where o.slug = any (select lower(trim(s)) from unnest(p_slugs) s)
$$;

revoke all on function tenant_slugs_taken(text[]) from public;
revoke all on function organization_slugs_taken(text[]) from public;
-- schools are only ever added by signed-in staff or org admins
grant execute on function tenant_slugs_taken(text[]) to authenticated;
-- organizations can also be created from the public sign-up page
grant execute on function organization_slugs_taken(text[]) to anon, authenticated;
