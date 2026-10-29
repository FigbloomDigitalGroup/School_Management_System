-- FIG-1314: three helper functions nobody should call directly.
--
-- QA 03's tenant matrix still flagged three definer functions after FIG-1297
-- (20261103200000), because anyone could call them for any school:
--
--   refresh_organization_tenant_summary(tenant)  anon and authenticated could
--     run it for any school id. It only recomputes that school's summary row,
--     but it's a write on demand for anybody. FIG-1297 left it open because
--     the triggers that call it (on students, attendance, fee_invoices and
--     tenants) weren't security definer, so they called it as the signed-in
--     user. Those two trigger functions now run as their owner, like the
--     helper they call, so nobody else needs execute on it.
--   teaches_learner(teacher, learner)  anon and authenticated could ask
--     whether any teacher teaches any learner. Nothing calls it: no function,
--     policy, app screen or edge function.
--   chat_teaches_student(teacher, learner)  the same question for signed-in
--     users. Only my_chat_contacts() and may_talk() call it, and they run as
--     their owner.
--
-- So execute is revoked from everyone on all three; the owner (and so the
-- functions and triggers above) still runs them. The functions themselves
-- are unchanged.
--
-- supabase/rls-checks/null_guards.sql checks it, and the summary still
-- refreshes when a school admin changes a learner.

alter function trg_refresh_org_summary_for_tenant() security definer set search_path = public;
alter function trg_refresh_org_summary_for_tenant_row() security definer set search_path = public;

revoke execute on function refresh_organization_tenant_summary(uuid) from public, anon, authenticated;
revoke execute on function teaches_learner(uuid, uuid) from public, anon, authenticated;
revoke execute on function chat_teaches_student(uuid, uuid) from public, anon, authenticated;
