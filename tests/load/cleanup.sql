\set ON_ERROR_STOP 1
set lock_timeout = '10s';
-- Load test: remove the throwaway school and its accounts. One transaction. LOCAL DATABASE ONLY.
-- Deleting the tenant cascades to every tenant_id table. Four row-level triggers are switched off first:
-- guard_student_delete refuses to delete learners who have invoices, and the org-summary triggers would
-- run once per deleted row. (The database writes a few "records removed" audit entries of its own; they
-- cannot be deleted and are the only trace left.)
begin;
alter table students     disable trigger students_guard_delete;
alter table students     disable trigger refresh_org_summary_students;
alter table attendance   disable trigger refresh_org_summary_attendance;
alter table fee_invoices disable trigger refresh_org_summary_fee_invoices;

create temp table load_ids on commit drop as
  select id from auth.users where email like '%@login.load-test.figbloom.internal' or email = 'principal@load-test.sc.ke';

delete from organization_tenant_summary where tenant_id = (select id from tenants where slug = 'load-test');
delete from tenants where slug = 'load-test';
delete from auth.users where id in (select id from load_ids);

alter table students     enable trigger students_guard_delete;
alter table students     enable trigger refresh_org_summary_students;
alter table attendance   enable trigger refresh_org_summary_attendance;
alter table fee_invoices enable trigger refresh_org_summary_fee_invoices;

select (select count(*) from tenants where slug = 'load-test') as load_tenants,
       (select count(*) from auth.users where email like '%load-test%') as load_auth_users;
commit;
vacuum analyze;
