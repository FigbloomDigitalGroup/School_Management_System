-- FIG-1297: permission checks that "can't tell" let the caller through.
--
-- may_administer() answered NULL, not false, for a caller with no profile row
-- (anyone not signed in, or signed in without a profile): `target_tenant_id =
-- my_tenant()` is NULL when my_tenant() is, and `false or NULL` is NULL.
-- has_perm(), has_office_perm() and may_teach_class_subject() inherit it.
-- Every guard written as `if not may_administer(...) then raise` (or `... or
-- not has_perm(...)`, or `exists (... where not has_perm(...))`) then reads
-- `not NULL`, which is NULL, so the raise never runs. 20261026080000 already
-- warned about exactly this for my_tenant()'s suspended sentinel.
--
-- Two layers:
--
--   1. The four helpers answer false whenever they can't tell. That fixes the
--      ~40 guards that call them without touching each function; the guards
--      that combine them inline (set_report_card_teacher_comment,
--      request_signatures, the payment proof triggers) also end up false,
--      since their other branches compare auth.uid() or use is_staff(), which
--      are already NULL-safe.
--   2. The data-changing definer functions that were still executable by anon
--      lose that grant. Each was created with only `revoke ... from public`,
--      but Supabase's default privileges grant execute to anon directly, so
--      someone holding nothing but the public key could call them.
--
-- refresh_organization_tenant_summary() is left alone on purpose: non-definer
-- triggers on attendance, fee_invoices, students and tenants call it as the
-- signed-in user, and revoking it would break those writes.
--
-- supabase/rls-checks/null_guards.sql checks both layers.

-- ------------------------------------------------------------ 1. helpers

create or replace function may_administer(target_tenant_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    is_super()
    or (target_tenant_id = my_tenant() and my_role() = 'school_admin')
    or (is_org_admin() and target_tenant_id in (select my_organization_tenant_ids())),
    false)
$$;

create or replace function has_perm(p_tenant uuid, p_area text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    may_administer(p_tenant)
    or exists (select 1 from my_areas(p_tenant) a where a = p_area),
    false)
$$;

create or replace function has_office_perm(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    may_administer(p_tenant)
    or exists (select 1 from my_areas(p_tenant) a where a <> 'visitors'),
    false)
$$;

create or replace function may_teach_class_subject(p_tenant_id uuid, p_class_id uuid, p_subject_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    has_perm(p_tenant_id, 'academics')
    or (
      p_tenant_id = my_tenant() and my_role() = 'teacher'
      and exists (
        select 1 from teaching_assignments ta
         where ta.teacher_id = auth.uid() and ta.class_id = p_class_id and ta.subject_id = p_subject_id
      )
    ),
    false)
$$;

-- ------------------------------------------------------------ 2. anon

revoke execute on function set_school_details(uuid, text, text, text) from public, anon;
revoke execute on function set_school_payment_methods(uuid, text, text, text, text) from public, anon;
revoke execute on function set_school_logo(uuid, text) from public, anon;
revoke execute on function set_school_accent(uuid, text) from public, anon;
revoke execute on function sign_documents(text, uuid[], text, text, text, jsonb, text[], text) from public, anon;
revoke execute on function void_signature(uuid, text) from public, anon;
revoke execute on function request_signatures(uuid, uuid[], text) from public, anon;
revoke execute on function issue_item_to_class(uuid, uuid, date) from public, anon;
revoke execute on function set_call_status(uuid, text) from public, anon;
