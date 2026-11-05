-- FIG-1427: starting a new term is one step, so a term the database refuses leaves the school's current term as it was.
--
-- Settings > Term dates switched the current term off with one request and inserted the new term with a second. If the insert was
-- refused (Term 3 of 2026 again, a term that ends the day it starts) the first request had already been saved, and the school was left
-- with no current term: 16 source files read it (the Dashboard, Fees, Reports, People, the parent's Fees and Home, report cards, teacher
-- and student data), so nothing worked until someone started a term again.
--
-- start_term() does both in one call, so one transaction: a refusal undoes the switch-off too. It runs with the caller's own rights
-- (security invoker), so the rule on who may change terms is unchanged, and a caller who may not changes nothing. The two ordinary
-- mistakes are refused in words, before anything is touched. Returns the new term's id.

create or replace function start_term(p_tenant_id uuid, p_year int, p_index int, p_starts_on date, p_ends_on date)
returns uuid
language plpgsql
set search_path = public
as $$
declare v_id uuid;
begin
  if exists (select 1 from terms where tenant_id = p_tenant_id and year = p_year and index = p_index) then
    raise exception 'Term %, % already exists for this school.', p_index, p_year using errcode = '23505';
  end if;
  if p_ends_on <= p_starts_on then
    raise exception 'The end date must be after the start date.' using errcode = '23514';
  end if;

  update terms set is_current = false where tenant_id = p_tenant_id and is_current;

  insert into terms (tenant_id, name, year, index, starts_on, ends_on, is_current)
  values (p_tenant_id, 'Term ' || p_index || ', ' || p_year, p_year, p_index, p_starts_on, p_ends_on, true)
  returning id into v_id;
  return v_id;
end $$;

revoke execute on function start_term(uuid, int, int, date, date) from public, anon;
grant execute on function start_term(uuid, int, int, date, date) to authenticated;
