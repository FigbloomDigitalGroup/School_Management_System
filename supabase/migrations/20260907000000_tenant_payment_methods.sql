-- Per-school payment methods (MVP): each school records its own paybill/till/
-- bank details, parents pay externally and upload proof (already built).
-- Real Daraja STK push + auto-confirm per tenant is a later phase once a
-- school has its own Safaricom developer account.

alter table tenants
  add column payment_paybill      text,
  add column payment_till         text,
  add column payment_bank_details text,
  add column payment_notes        text;

-- tenants otherwise only writes through tenant_write_super (super admin only,
-- see rls.sql) — a school admin must not be able to touch plan/status/seats,
-- so this is a narrow function rather than a row-scoped update policy.
create or replace function set_school_payment_methods(
  p_paybill text, p_till text, p_bank_details text, p_notes text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if my_role() <> 'school_admin' then
    raise exception 'only a school admin can set this school''s payment methods';
  end if;

  update tenants set
    payment_paybill      = nullif(trim(p_paybill), ''),
    payment_till         = nullif(trim(p_till), ''),
    payment_bank_details = nullif(trim(p_bank_details), ''),
    payment_notes        = nullif(trim(p_notes), '')
  where id = my_tenant();
end;
$$;

revoke all on function set_school_payment_methods(text, text, text, text) from public;
grant execute on function set_school_payment_methods(text, text, text, text) to authenticated;
