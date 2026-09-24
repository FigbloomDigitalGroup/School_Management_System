-- Fix: tenants.accent could only be set once, by Figbloom staff, in the
-- Onboard School wizard. Platform > Tenant > Branding only previews a
-- choice (it never saved), and the school's own Settings had no picker at
-- all -- so a school wanting a different accent had to ask a super admin
-- to edit the row by hand.
--
-- Same narrow-RPC shape as set_school_logo: a school admin (or an org_admin
-- acting inside the school) may change this one column and nothing else on
-- tenants. The value is limited to the six schoolAccents in
-- packages/shared/src/tokens.ts -- each is AA-contrast-checked on white, and
-- the column's own check constraint only enforces "a hex colour".

create function set_school_accent(p_tenant_id uuid, p_accent text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not may_administer(p_tenant_id) then
    raise exception 'you do not administer this school';
  end if;
  if upper(p_accent) not in ('#7A1F2B', '#123C63', '#1B4D2E', '#5C2E1F', '#3B3B6D', '#0F5257') then
    raise exception 'that accent is not one of the contrast-checked school accents';
  end if;

  update tenants set accent = upper(p_accent) where id = p_tenant_id;
end;
$$;
revoke all on function set_school_accent(uuid, text) from public;
grant execute on function set_school_accent(uuid, text) to authenticated;
