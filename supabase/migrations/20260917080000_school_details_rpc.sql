-- Fix: there was no way anywhere in the app for a school to correct its own
-- name/county/MOE registration after creation -- not for its own
-- school_admin, and not for an org_admin acting inside it either (they
-- share the same School settings screen once they "Open school console").
-- Only Figbloom staff could, and even Platform > Tenants never actually
-- exposed an edit form for these fields (just the read-only header).
--
-- Same narrow-RPC shape as set_school_payment_methods/set_school_logo: a
-- school admin must not be able to touch plan/status/seats/slug, so this is
-- a function with an explicit field list rather than a row-scoped update
-- policy on tenants.

create or replace function set_school_details(
  p_name text, p_county text, p_moe_registration text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if my_role() <> 'school_admin' then
    raise exception 'only a school admin can set this school''s details';
  end if;
  if trim(coalesce(p_name, '')) = '' then
    raise exception 'the school needs a name';
  end if;

  update tenants set
    name            = trim(p_name),
    county          = trim(p_county),
    moe_registration = nullif(trim(p_moe_registration), '')
  where id = my_tenant();
end;
$$;

revoke all on function set_school_details(text, text, text) from public;
grant execute on function set_school_details(text, text, text) to authenticated;
